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
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Highest event seq seen, so a restart resumes via --after (lossless). */
  private lastSeq: number | null = null;
  /** Epoch ms of the last byte received, for stall detection. */
  private lastDataAt = 0;
  /** Restart the stream if no data arrives for this long (silent stall). */
  private static readonly STALL_MS = 120_000;
  private static readonly WATCHDOG_MS = 30_000;

  constructor(opts: CmuxEventsServiceOptions) {
    this.bin = resolveCmuxBin(opts.bin ?? "cmux");
    this.store = opts.store;
    this.log = opts.logger ?? silentLogger;
    this.reconnectMs = opts.reconnectMs ?? 2000;
  }

  start(): void {
    this.stopped = false;
    this.spawnStream();
    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.checkStall(), CmuxEventsService.WATCHDOG_MS);
      this.watchdog.unref?.(); // never keep the process alive for this
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.child?.kill();
    this.child = null;
  }

  private spawnStream(): void {
    if (this.stopped) return;
    // Default flags (acks + heartbeats ON): --no-ack disables the flow-control
    // acks that keep cmux sending, which silently stalls the stream after a
    // while. No --category: we need agent.hook.* AND set_status; --after resumes
    // from the last seq so a restart loses nothing.
    const args = ["events", "--reconnect"];
    if (this.lastSeq != null) args.push("--after", String(this.lastSeq));
    let child: ChildProcess;
    try {
      child = spawn(this.bin, args, { env: cmuxEnv(), stdio: ["ignore", "pipe", "ignore"] });
    } catch (err) {
      this.log.warn(`cmux events spawn failed: ${message(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.child = child;
    this.buf = "";
    this.lastDataAt = Date.now();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.on("error", (err) => this.log.warn(`cmux events error: ${err.message}`));
    child.on("close", () => {
      this.child = null;
      this.scheduleReconnect();
    });
    this.log.info(`cmux events stream started${this.lastSeq != null ? ` (after seq ${this.lastSeq})` : ""}.`);
  }

  /** Parse newline-delimited JSON, feed the tracker, push on any change. */
  private onData(chunk: string): void {
    this.lastDataAt = Date.now();
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
      if (typeof ev.seq === "number" && (this.lastSeq == null || ev.seq > this.lastSeq)) {
        this.lastSeq = ev.seq;
      }
      if (this.tracker.ingest(ev)) changed = true;
    }
    if (changed) this.store.setWorkspaceStatus(this.tracker.snapshot());
  }

  /** Kill a silently stalled stream so `close` triggers a resumed reconnect. */
  private checkStall(): void {
    if (this.stopped || !this.child) return;
    if (Date.now() - this.lastDataAt > CmuxEventsService.STALL_MS) {
      this.log.warn("cmux events stream stalled (no data); restarting.");
      this.child.kill(); // → 'close' → scheduleReconnect() resumes via --after
    }
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
