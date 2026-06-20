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

/** Raw shape of a `cmux events` row (only the fields we read). */
export interface CmuxEvent {
  name?: unknown;
  occurred_at?: unknown;
  payload?: unknown;
}

/**
 * Accumulates the latest state per workspace from the agent event stream.
 *
 * Crucially, `since` only advances when the state actually *changes*: a burst
 * of PreToolUse events while working keeps the original "working since" time,
 * so the displayed duration reflects the whole burst, not the last tool call.
 */
export class WorkspaceStatusTracker {
  private readonly map = new Map<string, WorkspaceStatus>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * Ingest one event. Returns true iff it changed a workspace's status (so the
   * caller can skip a redundant store update). Non-agent events, unknown hook
   * names, and rows without a workspace id are ignored.
   */
  ingest(ev: CmuxEvent): boolean {
    if (typeof ev?.name !== "string" || !ev.name.startsWith("agent.hook.")) return false;
    const p = ev.payload && typeof ev.payload === "object" ? (ev.payload as Record<string, unknown>) : {};
    const wsId = typeof p.workspace_id === "string" ? p.workspace_id : "";
    if (!wsId) return false;
    const hook =
      typeof p.hook_event_name === "string" ? p.hook_event_name : ev.name.slice("agent.hook.".length);
    const state = hookToState(hook);
    if (!state) return false;

    const prev = this.map.get(wsId);
    if (prev && prev.state === state) return false; // same state: keep `since`

    const occurredMs = typeof ev.occurred_at === "string" ? Date.parse(ev.occurred_at) : NaN;
    const since = Number.isNaN(occurredMs) ? this.now() : occurredMs;
    this.map.set(wsId, { state, since });
    return true;
  }

  /** Immutable snapshot keyed by workspace id. */
  snapshot(): Record<string, WorkspaceStatus> {
    const out: Record<string, WorkspaceStatus> = {};
    for (const [k, v] of this.map) out[k] = { ...v };
    return out;
  }
}
