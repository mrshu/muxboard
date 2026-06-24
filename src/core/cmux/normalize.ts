import type { AgentKind, AttentionItem, AttentionReason, WorkspaceStatus } from "../types.js";
import { cleanTitle, detectActivity, type WorkspaceInfo } from "./workspaces.js";

const basename = (p: string): string => {
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
};

/**
 * Raw shape of a `cmux list-notifications --json` row, as verified against
 * cmux 0.64.16. Only the fields we rely on are typed; cmux may send more.
 */
export interface RawCmuxNotification {
  id?: unknown;
  title?: unknown;
  subtitle?: unknown;
  body?: unknown;
  is_read?: unknown;
  workspace_id?: unknown;
  surface_id?: unknown;
  tab_title?: unknown;
  created_at?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Optional user map of name substring → agent (e.g. {"fieldtheory":"codex"}). */
export type AgentAliases = Record<string, AgentKind>;

/**
 * Map a cmux notification's name to an agent kind.
 *
 * cmux puts the emitting agent's name in `title`/`tab_title`, but a custom name
 * (e.g. "fieldtheory-cli") carries no agent hint and cmux exposes none. So we
 * first consult a user-provided alias map (substring → agent), then the built-in
 * keywords, falling back to "unknown".
 */
export function detectAgent(name: string, aliases: AgentAliases = {}): AgentKind {
  const t = name.toLowerCase().trim();
  for (const [needle, agent] of Object.entries(aliases)) {
    if (needle && t.includes(needle.toLowerCase())) return agent;
  }
  if (t.includes("claude")) return "claude";
  if (t.includes("codex")) return "codex";
  // Pi: exact "pi"/"π", or a clear word boundary ("pi-agent", "pi cli").
  if (t === "pi" || t === "π" || /(^|[\s\-_/])pi([\s\-_/]|$)/.test(t)) return "pi";
  return "unknown";
}

/**
 * Derive an attention reason from a notification's STRUCTURED fields.
 *
 * Critically, "failed" is taken only from the notification `subtitle`/category —
 * never by scanning the free-form `body`. The body is frequently the agent's own
 * last message ("fixed the error", "tests were failing, now pass"), so keyword-
 * matching it for failure produces false FAILED tags. Permission requests use
 * Claude's specific phrasing, which is reliable. Everything else is "waiting"
 * (a notification means the pane wants you).
 */
export function detectReason(body: string, subtitle = ""): AttentionReason {
  const s = subtitle.toLowerCase();
  const b = body.toLowerCase();
  if (/\b(error|fail|failed|crash|crashed)\b/.test(s)) return "failed";
  if (s.includes("permission") || s.includes("approval")) return "blocked";
  if (
    /\bneeds?\b[^.]*\b(permission|approval)\b/.test(b) ||
    /permission to (run|use|execute|edit|write|read|access)/.test(b) ||
    /\b(approval needed|requesting (permission|approval)|awaiting approval)\b/.test(b)
  ) {
    return "blocked";
  }
  return "waiting";
}

/**
 * Build a human-friendly title from the notification when no workspace title is
 * available: cmux's `tab_title` (spinner-stripped; path-like names reduced to
 * their basename), falling back to a trimmed body so the key is never empty.
 */
function deriveTitle(tabTitle: string, body: string): string {
  const t = cleanTitle(tabTitle);
  if (t) return /^[~…/]/.test(t) ? basename(t) : t;
  const b = body.trim();
  return b.length > 40 ? `${b.slice(0, 39)}…` : b;
}

/**
 * Normalize a single raw cmux notification into an AttentionItem.
 *
 * Returns null when the row lacks the minimum fields we need (id + workspace),
 * so malformed rows are dropped rather than crashing the poll loop.
 */
/** Extra per-workspace context resolved from cmux, applied during normalization. */
export interface CmuxContext {
  /** workspaceId → agent, from the running process (authoritative). */
  agents?: Map<string, AgentKind>;
  /** workspaceId → best title + latest message, from `workspace list`. */
  workspaces?: Map<string, WorkspaceInfo>;
  /** Workspaces with a busy command running → epoch ms the busy window began. */
  busyWorkspaces?: Map<string, number>;
}

export function normalizeNotification(
  raw: RawCmuxNotification,
  aliases: AgentAliases = {},
  ctx: CmuxContext = {},
): AttentionItem | null {
  const id = str(raw.id);
  const workspaceId = str(raw.workspace_id);
  if (!id || !workspaceId) return null;

  const title = str(raw.title);
  const body = str(raw.body);
  const tabTitle = str(raw.tab_title);
  const createdAt = str(raw.created_at) || new Date(0).toISOString();

  // Prefer the agent detected from the actual running process (authoritative);
  // fall back to alias/keyword matching on the title + tab name.
  const processAgent = ctx.agents?.get(workspaceId);
  const ws = ctx.workspaces?.get(workspaceId);
  // Prefer the workspace's resolved title; fall back to the tab/body.
  const displayTitle = (ws?.title ?? "").trim() || deriveTitle(tabTitle, body);

  // cmux flips `is_read` when you merely *see* a notification (and muxboard's own
  // open-notification marks it read), NOT when you resolve it — so a read row can
  // still need you. We therefore keep read rows on the board rather than drop
  // them, but defuse their urgency: a read permission/failure demotes to plain
  // "waiting" (the key stays, losing the urgent badge + front-pin). Live "Needs"
  // status (from the event stream) re-flags genuine attention; an explicit clear
  // removes the key entirely (see the store's cleared-notification filter).
  const rawReason = detectReason(body, str(raw.subtitle));
  const reason: AttentionReason =
    raw.is_read === true && (rawReason === "blocked" || rawReason === "failed")
      ? "waiting"
      : rawReason;

  return {
    id,
    source: "cmux",
    agent: processAgent && processAgent !== "unknown" ? processAgent : detectAgent(`${title} ${tabTitle}`, aliases),
    workspaceId,
    surfaceId: str(raw.surface_id) || undefined,
    repo: tabTitle || undefined,
    title: displayTitle,
    reason,
    // Prefer the live workspace activity; fall back to the notification title glyph.
    activity: ws?.activity ?? detectActivity(title),
    busy: ctx.busyWorkspaces?.has(workspaceId) || undefined,
    busySince: ctx.busyWorkspaces?.get(workspaceId),
    color: ws?.color,
    body,
    message: (ws?.message ?? "").trim() || body,
    createdAt,
  };
}

/** Normalize a raw notification array, dropping malformed rows. */
export function normalizeNotifications(
  raw: unknown,
  aliases: AgentAliases = {},
  ctx: CmuxContext = {},
): AttentionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AttentionItem[] = [];
  for (const row of raw) {
    if (row && typeof row === "object") {
      const item = normalizeNotification(row as RawCmuxNotification, aliases, ctx);
      if (item) out.push(item);
    }
  }
  return out;
}

/**
 * Synthesize "running" items for agent workspaces that are actively working but
 * have no notification, so they can be listed at the end of the queue. A pane
 * counts as working when EITHER the live event stream reports it `running`
 * (authoritative `set_status`) OR its title carries cmux's spinner glyph (the
 * fallback when the stream is unavailable). The event-stream signal matters
 * because cmux omits the spinner from a workspace's JSON title once it has a
 * custom title, so the title heuristic alone misses every custom-titled pane.
 * `covered` is the set of workspace ids that already have a notification item
 * (skipped here to avoid duplicates); `status` is the live per-workspace status.
 */
export function buildRunningItems(
  workspaces: Map<string, WorkspaceInfo>,
  agents: Map<string, AgentKind>,
  covered: Set<string>,
  nowIso: string,
  status: Record<string, WorkspaceStatus> = {},
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const [workspaceId, ws] of workspaces) {
    const working = status[workspaceId]?.state === "running" || ws.activity === "working";
    if (!working || covered.has(workspaceId)) continue;
    out.push({
      id: workspaceId, // no notification; the workspace id is the focus key
      source: "cmux",
      agent: agents.get(workspaceId) ?? "unknown",
      workspaceId,
      title: (ws.title ?? "").trim() || workspaceId,
      reason: "waiting", // overridden by the working activity in render/triage
      activity: "working",
      color: ws.color,
      body: "",
      message: (ws.message ?? "").trim(),
      createdAt: nowIso,
      synthetic: true,
    });
  }
  return out;
}
