import { spawn, type ChildProcess } from "node:child_process";
import { cmuxEnv, resolveCmuxBin } from "../cmux/client.js";
import { WorkspaceStatusTracker, type CmuxEvent } from "../cmux/eventStatus.js";
import type { Store } from "./store.js";
import { type Logger, silentLogger } from "./logger.js";

export interface CmuxEventsServiceOptions {
  /** cmux binary path or name. Defaults to "cmux". */
  bin?: string;
  store: Store;
  logger?: Logger;
  /** Delay before respawning after the stream dies (default 2000ms). */
  reconnectMs?: number;
}

/**
 * Subscribes to cmux's agent event stream and feeds live per-workspace status
 * into the store.
 *
 * Runs `cmux events` as a long-lived child process, parses the newline-delimited
 * JSON, and maintains a WorkspaceStatusTracker (cmux's own `set_status` verdict,
 * falling back to raw agent hooks). On any state change it pushes a snapshot into
 * the store, which re-enriches the keys so activity + age reflect the live state
 * rather than a stale notification.
 *
 * Entirely best-effort: if cmux lacks `events`, the process dies, or spawning
 * fails, the plugin keeps working on the notification poll + title-glyph
 * fallback. The stream auto-respawns after `reconnectMs`.
 */
export class CmuxEventsService {
  private readonly bin: string;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly reconnectMs: number;
  private readonly tracker = new WorkspaceStatusTracker();
  private child: ChildProcess | null = null;
  private buf = "";
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: CmuxEventsServiceOptions) {
    this.bin = resolveCmuxBin(opts.bin ?? "cmux");
    this.store = opts.store;
    this.log = opts.logger ?? silentLogger;
    this.reconnectMs = opts.reconnectMs ?? 2000;
  }

  start(): void {
    this.stopped = false;
    this.spawnStream();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.child?.kill();
    this.child = null;
  }

  private spawnStream(): void {
    if (this.stopped) return;
    let child: ChildProcess;
    try {
      // No --category filter: we need both `agent.hook.*` (category agent) and
      // `set_status` (category sidebar). The tracker ignores everything else.
      child = spawn(this.bin, ["events", "--reconnect", "--no-heartbeat", "--no-ack"], {
        env: cmuxEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      this.log.warn(`cmux events spawn failed: ${message(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.child = child;
    this.buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.on("error", (err) => this.log.warn(`cmux events error: ${err.message}`));
    child.on("close", () => {
      this.child = null;
      this.scheduleReconnect();
    });
    this.log.info("cmux events stream started.");
  }

  /** Parse newline-delimited JSON, feed the tracker, push on any change. */
  private onData(chunk: string): void {
    this.buf += chunk;
    let changed = false;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let ev: CmuxEvent;
      try {
        ev = JSON.parse(line) as CmuxEvent;
      } catch {
        continue; // partial/garbage line; skip
      }
      if (this.tracker.ingest(ev)) changed = true;
    }
    if (changed) this.store.setWorkspaceStatus(this.tracker.snapshot());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.spawnStream();
    }, this.reconnectMs);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
