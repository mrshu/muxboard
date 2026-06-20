import type { CodexbarClient } from "../codexbar/client.js";
import type { Store } from "./store.js";
import { type Logger, silentLogger } from "./logger.js";

export interface CodexbarServiceOptions {
  client: CodexbarClient;
  store: Store;
  providers: string[];
  /** Poll interval in ms (default 45000). */
  pollMs?: number;
  /** Epoch-ms clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  logger?: Logger;
}

/**
 * Polls CodexBar usage per provider and pushes it into the store.
 *
 * Keeps the last good usage on failure (offline flag set), so the LCD shows
 * stale data with a clear marker rather than going blank. cmux keys are wholly
 * independent of this service.
 */
export class CodexbarService {
  private readonly client: CodexbarClient;
  private readonly store: Store;
  private readonly providers: string[];
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(opts: CodexbarServiceOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.providers = opts.providers.length > 0 ? opts.providers : ["codex"];
    this.pollMs = opts.pollMs ?? 45000;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.logger ?? silentLogger;
  }

  /** Staleness threshold: data older than 2× the poll interval. */
  get staleThresholdMs(): number {
    return this.pollMs * 2;
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

  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const usages = await this.client.getUsageAll(this.providers);
      const anyOk = usages.some((u) => u.ok);
      // If the whole server is unreachable, every provider errors with the same
      // transport message — treat that as offline and keep last good data.
      const offline = !anyOk;
      if (offline) {
        this.log.warn("codexbar poll: all providers unavailable");
      }
      this.store.setUsage(usages, this.now(), offline);
    } catch (err) {
      this.log.warn(`codexbar poll failed: ${message(err)}`);
      this.store.setUsage([], this.now(), true);
    } finally {
      this.inFlight = false;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when the last successful CodexBar refresh is older than the threshold. */
export function isStale(
  updatedAtMs: number | null,
  nowMs: number,
  thresholdMs: number,
): boolean {
  if (updatedAtMs === null) return true;
  return nowMs - updatedAtMs > thresholdMs;
}
