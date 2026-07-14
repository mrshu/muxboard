import type { CodexbarClient } from "../codexbar/client.js";
import type { Store } from "./store.js";
import { type Logger, silentLogger } from "./logger.js";

export interface CodexbarServiceOptions {
  client: CodexbarClient;
  store: Store;
  /**
   * Optional allow-list/order. Empty (default) auto-discovers every provider
   * CodexBar has enabled — the provider list is not hardcoded.
   */
  providers?: string[];
  /** Poll interval in ms (default 45000). */
  pollMs?: number;
  /** Epoch-ms clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  logger?: Logger;
}

/**
 * Polls CodexBar and pushes per-provider usage into the store.
 *
 * Providers are discovered dynamically from CodexBar (`GET /usage`), so the LCD
 * reflects exactly what CodexBar has enabled. An optional `providers` allow-list
 * filters/orders the result. Keeps last-good data on failure (offline flag set).
 */
export class CodexbarService {
  private readonly client: CodexbarClient;
  private readonly store: Store;
  private readonly allow: string[];
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /**
   * Provider ids seen in the last poll that returned at least one live provider.
   * Fed back into discovery so a flaky aggregate `/usage` (empty or omitting a
   * provider) re-fetches known providers individually instead of blanking them.
   */
  private lastGood: string[] = [];

  constructor(opts: CodexbarServiceOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.allow = opts.providers ?? [];
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
      const known = this.allow.length > 0 ? this.allow : this.lastGood;
      let usages = await this.client.getAllUsage(known);
      if (this.allow.length > 0) {
        const order = new Map(this.allow.map((p, i) => [p, i]));
        usages = usages
          .filter((u) => order.has(u.provider))
          .sort((a, b) => (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0));
      }
      // Offline when nothing came back, or every provider errored — a live
      // per-provider fetch (from the discovery fallback) is what proves the
      // server is actually up. On offline, push [] so the store keeps last-good.
      const offline = usages.length === 0 || usages.every((u) => !u.ok);
      if (offline) {
        this.log.warn("codexbar poll: no providers (server unavailable?)");
        this.store.setUsage([], this.now(), true);
      } else {
        // Push every provider we saw so the display order keeps them all; the
        // store retains last-good for any that failed transiently (server
        // flapping) instead of blanking them. Real provider errors still show.
        this.lastGood = usages.map((u) => u.provider);
        const live = usages.filter((u) => u.ok).map((u) => u.provider);
        this.log.info(`codexbar poll ok: ${live.join(",")}`);
        this.store.setUsage(usages, this.now(), false);
      }
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
