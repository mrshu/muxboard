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
 * Pick the agent that best characterizes the worktree's current status: the
 * MOST RECENT agent whose state matches the status (falling back to the most
 * recent of all agents). Selecting by recency rather than array order makes the
 * rendered reason deterministic for a multi-agent worktree — e.g. a `done`
 * worktree with both an interrupted and a clean agent always reflects the latest.
 */
function primaryAgent(agents: RawOrcaAgent[], status: string): RawOrcaAgent | undefined {
  const wantState =
    status === "permission"
      ? (s: string) => s === "waiting" || s === "blocked"
      : status === "working"
        ? (s: string) => s === "working"
        : status === "done"
          ? (s: string) => s === "done"
          : () => false;
  const matching = agents.filter((a) => wantState(str(a.state)));
  const pool = matching.length ? matching : agents;
  return pool.reduce<RawOrcaAgent | undefined>(
    (best, a) => (best && recency(best) >= recency(a) ? best : a),
    undefined,
  );
}

/** ISO timestamp from an epoch-ms value, falling back to nowIso. */
function iso(ms: number | undefined, nowIso: string): string {
  return ms != null ? new Date(ms).toISOString() : nowIso;
}

/**
 * Normalize one `worktree ps` row to an AttentionItem, or null when the
 * worktree does not warrant a key (status active/inactive, i.e. no live agent
 * that finished or needs you).
 */
export function normalizeWorktree(raw: RawOrcaWorktree, nowIso: string): AttentionItem | null {
  const workspaceId = str(raw.worktreeId);
  const status = str(raw.status);
  if (!workspaceId || (status !== "permission" && status !== "working" && status !== "done")) {
    return null;
  }
  const agents = Array.isArray(raw.agents) ? (raw.agents as RawOrcaAgent[]) : [];
  const primary = primaryAgent(agents, status);
  const agent = primary ? toAgentKind(str(primary.agentType)) : "unknown";
  const title = str(raw.displayName) || str(raw.repo) || workspaceId;
  const message = primary ? str(primary.lastAssistantMessage) || str(primary.prompt) : "";
  const since = primary ? num(primary.stateStartedAt) : undefined;
  const createdAt = iso(
    since ?? (primary ? num(primary.updatedAt) : undefined) ?? num(raw.lastOutputAt),
    nowIso,
  );

  let reason: AttentionReason;
  let activity: "working" | "waiting";
  let needsInput: true | undefined;
  let synthetic: true | undefined;

  if (status === "permission") {
    reason = "blocked";
    activity = "waiting";
    needsInput = true;
  } else if (status === "working") {
    reason = "waiting"; // overridden by the working activity in render/triage
    activity = "working";
    synthetic = true;
  } else {
    // status === "done"
    reason = primary && primary.interrupted === true ? "failed" : "finished";
    activity = "waiting";
  }

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
