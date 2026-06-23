import type { AgentKind, AttentionItem, AttentionReason } from "../types.js";

/** Per-agent row from `orca worktree ps --json`. Only fields we use are typed. */
export interface RawOrcaAgent {
  state?: unknown;             // "working" | "blocked" | "waiting" | "done"
  agentType?: unknown;         // "claude" | "codex" | ... (open set)
  prompt?: unknown;
  lastAssistantMessage?: unknown;
  toolName?: unknown;          // the tool the agent last invoked, e.g. "AskUserQuestion"
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
  if (ms == null) return nowIso;
  const d = new Date(ms);
  // An out-of-range (but finite) epoch throws from toISOString(); fall back
  // rather than let one bad timestamp reject the whole poll.
  return Number.isFinite(d.getTime()) ? d.toISOString() : nowIso;
}

/**
 * Normalize one `worktree ps` row to an AttentionItem, or null when the
 * worktree does not warrant a key (status active/inactive, i.e. no live agent
 * that finished or needs you).
 */
export function normalizeWorktree(raw: RawOrcaWorktree, nowIso: string): AttentionItem | null {
  const workspaceId = str(raw.worktreeId);
  if (!workspaceId) return null;
  const agents = Array.isArray(raw.agents) ? (raw.agents as RawOrcaAgent[]) : [];

  // An agent that called AskUserQuestion is blocked on your answer, but Orca
  // leaves the worktree status at "active" rather than rolling it up to
  // "permission" the way a tool-permission prompt does. Detect that off the
  // agent's toolName and treat it as a permission-style needs-input row so the
  // question still surfaces as a key. A blocked question is the highest-priority
  // state, so it wins over the raw status when both are present.
  const asking = agents.some(
    (a) =>
      str(a.toolName) === "AskUserQuestion" &&
      (str(a.state) === "waiting" || str(a.state) === "blocked"),
  );
  const rawStatus = str(raw.status);
  const status = asking
    ? "permission"
    : rawStatus === "permission" || rawStatus === "working" || rawStatus === "done"
      ? rawStatus
      : "";
  // Only permission/working/done (or an AskUserQuestion-blocked agent) warrant a
  // key; an active/inactive worktree with no pending question does not.
  if (!status) return null;
  const primary = primaryAgent(agents, status);
  // A surfaced status (permission/working/done) is rolled up from agent states,
  // so a row with no agents is malformed — drop it rather than invent a key.
  if (!primary) return null;
  const agent = toAgentKind(str(primary.agentType));
  const title = str(raw.displayName) || str(raw.repo) || workspaceId;
  const message = str(primary.lastAssistantMessage) || str(primary.prompt);
  const since = num(primary.stateStartedAt);
  const createdAt = iso(
    since ?? num(primary.updatedAt) ?? num(raw.lastOutputAt),
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
    reason = primary.interrupted === true ? "failed" : "finished";
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
