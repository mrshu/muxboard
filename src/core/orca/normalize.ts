import type { AgentKind, AttentionItem, AttentionReason } from "../types.js";

/** Per-agent row from `orca worktree ps --json`. Only fields we use are typed. */
export interface RawOrcaAgent {
  state?: unknown;             // "working" | "blocked" | "waiting" | "done"
  agentType?: unknown;         // "claude" | "codex" | ... (open set)
  prompt?: unknown;
  lastAssistantMessage?: unknown;
  interrupted?: unknown;
  stateStartedAt?: unknown;    // epoch ms
  updatedAt?: unknown;         // epoch ms
}

/** A worktree row from `orca worktree ps --json`. */
export interface RawOrcaWorktree {
  worktreeId?: unknown;
  repo?: unknown;
  displayName?: unknown;
  path?: unknown;
  branch?: unknown;
  status?: unknown;            // inactive|active|done|working|permission
  unread?: unknown;
  lastOutputAt?: unknown;      // epoch ms
  agents?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Map an Orca agentType to muxboard's narrower AgentKind. */
export function toAgentKind(agentType: string): AgentKind {
  const t = agentType.toLowerCase().trim();
  if (t === "claude") return "claude";
  if (t === "codex") return "codex";
  if (t === "pi") return "pi";
  return "unknown";
}

/** Recency of an agent's current state, for deterministic primary selection. */
function recency(a: RawOrcaAgent): number {
  return num(a.stateStartedAt) ?? num(a.updatedAt) ?? 0;
}

/**
 * Pick the agent that characterizes the worktree: the MOST RECENT one by state
 * change. Selecting by recency rather than array order makes the rendered reason
 * deterministic for a multi-agent worktree — e.g. one with both an interrupted
 * and a clean agent always reflects the latest.
 */
function primaryAgent(agents: RawOrcaAgent[]): RawOrcaAgent | undefined {
  return agents.reduce<RawOrcaAgent | undefined>(
    (best, a) => (best && recency(best) >= recency(a) ? best : a),
    undefined,
  );
}

/** ISO timestamp from an epoch-ms value, falling back to nowIso. */
function iso(ms: number | undefined, nowIso: string): string {
  if (ms == null) return nowIso;
  const d = new Date(ms);
  // An out-of-range (but finite) epoch throws from toISOString(); fall back
  // rather than let one bad timestamp reject the whole poll.
  return Number.isFinite(d.getTime()) ? d.toISOString() : nowIso;
}

/**
 * Normalize one `worktree ps` row to an AttentionItem, or null when the
 * worktree does not warrant a key.
 *
 * Orca's worktree-level `status` is a terminal-liveness flag (PTY alive →
 * "active", else "inactive"); it does NOT roll up the agent lifecycle — a
 * finished, working, or question-blocked agent all leave the worktree "active".
 * So attention is derived from the primary agent's own `state`
 * (working|blocked|waiting|done), not the worktree status.
 */
export function normalizeWorktree(raw: RawOrcaWorktree, nowIso: string): AttentionItem | null {
  const workspaceId = str(raw.worktreeId);
  if (!workspaceId) return null;
  const agents = Array.isArray(raw.agents) ? (raw.agents as RawOrcaAgent[]) : [];
  const primary = primaryAgent(agents);
  // No live agent → nothing to surface (an idle/empty worktree).
  if (!primary) return null;

  const state = str(primary.state);
  let reason: AttentionReason;
  let activity: "working" | "waiting";
  let needsInput: true | undefined;
  let synthetic: true | undefined;

  if (state === "waiting" || state === "blocked") {
    // The agent is asking you for input/permission (a tool-permission prompt or
    // an AskUserQuestion); Orca reports this on the agent, not the worktree.
    reason = "blocked";
    activity = "waiting";
    needsInput = true;
  } else if (state === "working") {
    reason = "waiting"; // overridden by the working activity in render/triage
    activity = "working";
    synthetic = true;
  } else if (state === "done") {
    // A finished agent warrants a key only while the worktree is unread (has
    // unseen output) — otherwise it's an old result you've already looked at.
    // Focusing the worktree clears its unread in Orca, so the key goes away once
    // you act. This keeps finished agents from lingering as stale keys forever.
    if (raw.unread !== true) return null;
    reason = primary.interrupted === true ? "failed" : "finished";
    activity = "waiting";
  } else {
    return null; // unknown/idle agent state: nothing to surface
  }

  const agent = toAgentKind(str(primary.agentType));
  const title = str(raw.displayName) || str(raw.repo) || workspaceId;
  const message = str(primary.lastAssistantMessage) || str(primary.prompt);
  const since = num(primary.stateStartedAt);
  const createdAt = iso(
    since ?? num(primary.updatedAt) ?? num(raw.lastOutputAt),
    nowIso,
  );

  return {
    id: workspaceId, // no notification; the worktree id is the focus key
    source: "orca",
    agent,
    workspaceId,
    repo: str(raw.repo) || undefined,
    title,
    reason,
    activity,
    needsInput,
    activitySince: since,
    body: "",
    message,
    createdAt,
    synthetic,
  };
}

/** Normalize the `result.worktrees` array, dropping non-attention rows. */
export function normalizeWorktrees(raw: unknown, nowIso: string): AttentionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AttentionItem[] = [];
  for (const row of raw) {
    if (row && typeof row === "object") {
      const item = normalizeWorktree(row as RawOrcaWorktree, nowIso);
      if (item) out.push(item);
    }
  }
  return out;
}
