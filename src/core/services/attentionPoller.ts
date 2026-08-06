import type { AttentionItem, AttentionSource } from "../types.js";
import type { Store } from "./store.js";
import { type Logger, message, silentLogger } from "./logger.js";

export interface AttentionPollerOptions {
  store: Store;
  /** Poll interval in ms (default 1500). */
  pollMs?: number;
  logger?: Logger;
}

/**
 * Interval poll loop shared by the attention sources: fetch this source's items
 * and push them into the store under its own slice.
 *
 * Robustness rules:
 *  - A failed poll (CLI missing, nonzero exit, bad JSON) marks the source
 *    offline but keeps the last good items, so a transient hiccup never blanks
 *    the keys.
 *  - Two consecutive failures are required before flipping to offline, to ride
 *    out a single dropped call.
 */
export abstract class AttentionPoller {
  protected readonly store: Store;
  private readonly source: AttentionSource;
  private readonly pollMs: number;
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private consecutiveFailures = 0;

  protected constructor(source: AttentionSource, opts: AttentionPollerOptions) {
    this.source = source;
    this.store = opts.store;
    this.pollMs = opts.pollMs ?? 1500;
    this.log = opts.logger ?? silentLogger;
  }

  /** Fetch the source's current attention items; throws when it is unreachable. */
  protected abstract fetch(): Promise<AttentionItem[]>;

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
      const items = await this.fetch();
      this.consecutiveFailures = 0;
      this.store.setAttention(items, false, this.source);
    } catch (err) {
      this.consecutiveFailures++;
      const detail =
        err && typeof err === "object" && "stderr" in err
          ? ` stderr=${String((err as { stderr?: unknown }).stderr).slice(0, 200)}`
          : "";
      this.log.warn(`${this.source} poll failed (${this.consecutiveFailures}): ${message(err)}${detail}`);
      if (this.consecutiveFailures >= 2) this.store.setSourceOffline(this.source, true);
    } finally {
      this.inFlight = false;
    }
  }
}
