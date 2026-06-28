/**
 * Per-workspace live status derived from cmux's agent event stream
 * (`cmux events --category agent`).
 *
 * cmux emits structured agent-lifecycle hooks — `agent.hook.PreToolUse`,
 * `Stop`, `Notification`, `UserPromptSubmit`, … — each carrying a
 * `workspace_id` and an `occurred_at`. That is a far better signal than the
 * notification `created_at` (which only marks when a message fired) or the
 * title spinner glyph: it tells us the *current* state and exactly *when* it
 * changed, so a key can show "working for 2m" or "waiting since 19:50"
 * accurately instead of the age of a stale, lingering notification.
 *
 * This module is dependency-free so it can be unit-tested without cmux.
 */

import type { WorkspaceState, WorkspaceStatus } from "../types.js";

export type { WorkspaceState, WorkspaceStatus };

/** Hook events that mean the agent is actively working. */
const RUNNING_HOOKS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact"]);
/** Hook events that mean the agent is blocked, waiting on you. */
const NEEDS_HOOKS = new Set(["Notification", "AskUserQuestion"]);
/** Hook events that mean the agent finished its turn (idle / waiting for you). */
const IDLE_HOOKS = new Set(["Stop", "SubagentStop", "SessionEnd"]);

/** Map a Claude/Codex hook event name to a workspace state (null = ignore). */
export function hookToState(hookEventName: string): WorkspaceState | null {
  if (RUNNING_HOOKS.has(hookEventName)) return "running";
  if (NEEDS_HOOKS.has(hookEventName)) return "needs";
  if (IDLE_HOOKS.has(hookEventName)) return "idle";
  return null;
}

/**
 * Map cmux's own computed status label to a state. cmux pushes these via
 * `sidebar.metadata.updated` (`set_status`), e.g. "Running" / "Idle" /
 * "Needs input" — its authoritative, debounced verdict that drives its UI.
 */
export function statusLabelToState(label: string): WorkspaceState | null {
  const v = label.trim().toLowerCase();
  if (v.startsWith("running")) return "running";
  if (v.startsWith("idle")) return "idle";
  if (v.startsWith("needs")) return "needs";
  return null;
}

/** Raw shape of a `cmux events` row (only the fields we read). */
export interface CmuxEvent {
  name?: unknown;
  occurred_at?: unknown;
  payload?: unknown;
  /** Monotonic sequence number, used to resume the stream after a restart. */
  seq?: unknown;
}

type Tracked = WorkspaceStatus & { source: "status" | "hook" };

/**
 * Accumulates the latest state per workspace from the cmux event stream.
 *
 * Two sources, in priority order:
 *  1. cmux's own `set_status` verdict (sidebar.metadata.updated) — authoritative;
 *     it's what drives cmux's UI, so we trust it over re-deriving anything.
 *  2. raw `agent.hook.*` events — a fallback for workspaces cmux doesn't publish
 *     a status for, mapped to running/needs/idle ourselves.
 *
 * Once a workspace has a `set_status`, hook events for it are ignored so the two
 * sources can't fight — except a terminal `Stop`/`SessionEnd` hook may still
 * close out a stale `running` verdict, since cmux often emits the Running
 * set_status without ever publishing the matching Idle one. `since` only
 * advances when the state actually *changes*,
 * so a burst of events while working keeps the original "working since" time and
 * the displayed duration reflects the whole burst, not the last event.
 */
export class WorkspaceStatusTracker {
  private readonly map = new Map<string, Tracked>();
  /**
   * Epoch ms of the latest event of ANY kind per workspace — i.e. the last sign
   * of life. Unlike `since` (which only advances on a state CHANGE), this moves
   * on every event in a working burst, so a working agent that has gone silent
   * (no hooks for a while) can be told apart from a healthy long-running one.
   */
  private readonly lastSeen = new Map<string, number>();
  /** Epoch ms of the latest user "clear notifications" per workspace id. */
  private readonly cleared = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * Ingest one event. Returns true iff it changed a workspace's status (so the
   * caller can skip a redundant store update). Irrelevant events are ignored.
   */
  ingest(ev: CmuxEvent): boolean {
    const name = typeof ev?.name === "string" ? ev.name : "";
    const p = ev.payload && typeof ev.payload === "object" ? (ev.payload as Record<string, unknown>) : {};
    if (name === "sidebar.metadata.updated") return this.ingestStatus(p, ev.occurred_at);
    if (name === "notification.clear_requested") return this.ingestClear(p, ev.occurred_at);
    if (name.startsWith("agent.hook.")) {
      const hook = typeof p.hook_event_name === "string" ? p.hook_event_name : name.slice("agent.hook.".length);
      return this.apply(typeof p.workspace_id === "string" ? p.workspace_id : "", hookToState(hook), ev.occurred_at, "hook");
    }
    return false;
  }

  /** Parse a `set_status` sidebar event: `<key> <Label...> --tab=<wsId> …`. */
  private ingestStatus(p: Record<string, unknown>, occurredAt: unknown): boolean {
    if (typeof p.command !== "string" || !p.command.includes("set_status")) return false;
    const args = typeof p.args === "string" ? p.args : "";
    const tab = /--tab=(\S+)/.exec(args);
    if (!tab) return false;
    // Status value = the tokens after the key, before any --flag (e.g. "Needs input").
    const value = args
      .split(/\s+/)
      .slice(1)
      .filter((t) => !t.startsWith("--"))
      .join(" ");
    return this.apply(tab[1], statusLabelToState(value), occurredAt, "status");
  }

  /**
   * Record a user "clear notifications" action for a workspace. cmux emits
   * `notification.clear_requested` the instant you clear a workspace's
   * notifications in its UI; the top-level `workspace_id` is null and the target
   * rides in `args` as `--tab=<id>` (same shape as set_status). We keep the
   * latest clear time per workspace so the store can drop any key that fired at
   * or before it — clearing the prompt removes its key immediately, ahead of the
   * next poll, and even when the row was still unread. A re-ask (a newer
   * notification) survives because its createdAt is past the clear time.
   */
  private ingestClear(p: Record<string, unknown>, occurredAt: unknown): boolean {
    const args = typeof p.args === "string" ? p.args : "";
    const tab = /--tab=(\S+)/.exec(args);
    if (!tab) return false;
    const ms = typeof occurredAt === "string" ? Date.parse(occurredAt) : NaN;
    const at = Number.isNaN(ms) ? this.now() : ms;
    const prev = this.cleared.get(tab[1]);
    if (prev != null && prev >= at) return false; // keep the latest clear only
    this.cleared.set(tab[1], at);
    return true;
  }

  /** Apply a resolved (wsId, state) with source precedence + since-on-change. */
  private apply(wsId: string, state: WorkspaceState | null, occurredAt: unknown, source: "status" | "hook"): boolean {
    if (!wsId || !state) return false;
    const prev = this.map.get(wsId);
    const occurredMs = typeof occurredAt === "string" ? Date.parse(occurredAt) : NaN;
    // Record last-sign-of-life on EVERY event (even same-state bursts and
    // precedence-ignored hooks): the agent is clearly alive if it's emitting.
    const seenMs = Number.isNaN(occurredMs) ? this.now() : occurredMs;
    const prevSeen = this.lastSeen.get(wsId);
    if (prevSeen == null || seenMs > prevSeen) this.lastSeen.set(wsId, seenMs);
    if (prev && source === "hook" && prev.source === "status") {
      // cmux's set_status verdict normally wins over noisy hooks. One exception:
      // a terminal idle hook (Stop/SessionEnd) superseding a stale "running"
      // verdict. cmux reliably emits the Running set_status but routinely omits
      // the matching Idle one, so without this a finished agent stays "working"
      // forever. Require the hook to be newer than the running burst's start so
      // a replayed/out-of-order Stop can't clear a genuinely live run.
      const closesStaleRun = state === "idle" && prev.state === "running" && !Number.isNaN(occurredMs) && occurredMs >= prev.since;
      if (!closesStaleRun) return false;
    }
    if (prev && prev.state === state) {
      if (prev.source !== source) prev.source = source; // upgrade hook→status authority
      return false; // same state: keep `since`
    }
    const since = Number.isNaN(occurredMs) ? this.now() : occurredMs;
    this.map.set(wsId, { state, since, source });
    return true;
  }

  /** Immutable snapshot keyed by workspace id (source is internal). */
  snapshot(): Record<string, WorkspaceStatus> {
    const out: Record<string, WorkspaceStatus> = {};
    for (const [k, v] of this.map) out[k] = { state: v.state, since: v.since, lastSeen: this.lastSeen.get(k) };
    return out;
  }

  /** Epoch ms of the latest user "clear notifications" per workspace id. */
  clearedSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.cleared) out[k] = v;
    return out;
  }
}
