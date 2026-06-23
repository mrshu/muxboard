import type { OrcaClient } from "../orca/client.js";
import type { Store } from "./store.js";
import { type Logger, silentLogger } from "./logger.js";

export interface OrcaServiceOptions {
  client: OrcaClient;
  store: Store;
  /** Poll interval in ms (default 1500). */
  pollMs?: number;
  logger?: Logger;
}

/**
 * Polls Orca for the attention queue and pushes it into the store under the
 * "orca" source. Same robustness rules as CmuxService: keep the last good items
 * on a transient miss, and require two consecutive failures before flipping the
 * orca feed offline.
 */
export class OrcaService {
  private readonly client: OrcaClient;
  private readonly store: Store;
  private readonly pollMs: number;
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private consecutiveFailures = 0;

  constructor(opts: OrcaServiceOptions) {
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

  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const items = await this.client.listAttention();
      this.consecutiveFailures = 0;
      this.store.setAttention(items, false, "orca");
    } catch (err) {
      this.consecutiveFailures++;
      const detail =
        err && typeof err === "object" && "stderr" in err
          ? ` stderr=${String((err as { stderr?: unknown }).stderr).slice(0, 200)}`
          : "";
      this.log.warn(`orca poll failed (${this.consecutiveFailures}): ${message(err)}${detail}`);
      if (this.consecutiveFailures >= 2) {
        this.store.setSourceOffline("orca", true);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
