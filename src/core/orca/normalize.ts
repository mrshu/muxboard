import type { AgentKind, AttentionItem, AttentionReason } from "../types.js";

/** Per-agent row from `orca worktree ps --json`. Only fields we use are typed. */
export interface RawOrcaAgent {
  state?: unknown;             // "working" | "blocked" | "waiting" | "done"
  agentType?: unknown;         // "claude" | "codex" | ... (open set)
  prompt?: unknown;
  lastAssistantMessage?: unknown;
  interrupted?: unknown;
  stateStartedAt?: unknown;    // epoch ms
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

/** Pick the agent that best characterizes the worktree's current status. */
function primaryAgent(agents: RawOrcaAgent[], status: string): RawOrcaAgent | undefined {
  if (status === "permission") return agents.find((a) => str(a.state) === "waiting" || str(a.state) === "blocked") ?? agents[0];
  if (status === "working") return agents.find((a) => str(a.state) === "working") ?? agents[0];
  if (status === "done") return agents.find((a) => str(a.state) === "done") ?? agents[0];
  return agents[0];
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
  const createdAt = iso(since ?? num(raw.lastOutputAt), nowIso);

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
