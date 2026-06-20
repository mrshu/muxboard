import type { CmuxClient } from "../cmux/client.js";
import type { Store } from "./store.js";
import { type Logger, silentLogger } from "./logger.js";

export interface CmuxServiceOptions {
  client: CmuxClient;
  store: Store;
  /** Poll interval in ms (default 1500). */
  pollMs?: number;
  logger?: Logger;
}

/**
 * Polls cmux for the attention queue and pushes it into the store.
 *
 * Robustness rules:
 *  - A failed poll (CLI missing, nonzero exit, bad JSON) marks cmux offline but
 *    keeps the last good items, so a transient hiccup never blanks the keys.
 *  - Two consecutive failures are required before flipping to offline, to ride
 *    out a single dropped call.
 */
export class CmuxService {
  private readonly client: CmuxClient;
  private readonly store: Store;
  private readonly pollMs: number;
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private consecutiveFailures = 0;

  constructor(opts: CmuxServiceOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.pollMs = opts.pollMs ?? 1500;
    this.log = opts.logger ?? silentLogger;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run a single poll now (also used by dial 4 force-refresh). */
  async poll(): Promise<void> {
    if (this.inFlight) return; // never overlap polls
    this.inFlight = true;
    try {
      const items = await this.client.listAttention();
      this.consecutiveFailures = 0;
      this.store.setAttention(items, false);
    } catch (err) {
      this.consecutiveFailures++;
      this.log.warn(`cmux poll failed (${this.consecutiveFailures}): ${message(err)}`);
      if (this.consecutiveFailures >= 2) {
        this.store.setCmuxOffline(true);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
