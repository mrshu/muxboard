import type { AgentKind, AttentionItem, AttentionReason } from "../types.js";

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

/**
 * Map a cmux notification title to an agent kind.
 *
 * cmux puts the emitting agent in `title` (e.g. "Claude Code", "fieldtheory-cli").
 * We match the known coding agents and fall back to "unknown" so custom agent
 * names still render (just without a branded palette).
 */
export function detectAgent(title: string): AgentKind {
  const t = title.toLowerCase().trim();
  if (t.includes("claude")) return "claude";
  if (t.includes("codex")) return "codex";
  // Pi: exact "pi"/"π", or a clear word boundary ("pi-agent", "pi cli").
  if (t === "pi" || t === "π" || /(^|[\s\-_/])pi([\s\-_/]|$)/.test(t)) return "pi";
  return "unknown";
}

/**
 * Derive an attention reason from the cmux notification body.
 *
 * This reads cmux's own *structured* notification text — it is not terminal
 * scraping. Order matters: the strongest signal wins.
 */
export function detectReason(body: string): AttentionReason {
  const b = body.toLowerCase();
  if (/\b(fail|failed|error|crashed|exception)\b/.test(b)) return "failed";
  if (/\b(permission|approve|approval|blocked|denied|confirm)\b/.test(b)) return "blocked";
  if (/\b(waiting|awaiting|input|ready for|your turn)\b/.test(b)) return "waiting";
  if (/\b(done|finished|complete|completed|ready)\b/.test(b)) return "finished";
  return "unknown";
}

/**
 * Build a short, human-friendly title for the key.
 *
 * Prefers cmux's `tab_title` (often the workspace/repo name), falling back to a
 * trimmed notification body so the key is never empty.
 */
function deriveTitle(tabTitle: string, body: string): string {
  const t = tabTitle.trim();
  if (t) return t;
  const b = body.trim();
  return b.length > 40 ? `${b.slice(0, 39)}…` : b;
}

/**
 * Normalize a single raw cmux notification into an AttentionItem.
 *
 * Returns null when the row lacks the minimum fields we need (id + workspace),
 * so malformed rows are dropped rather than crashing the poll loop.
 */
export function normalizeNotification(raw: RawCmuxNotification): AttentionItem | null {
  const id = str(raw.id);
  const workspaceId = str(raw.workspace_id);
  if (!id || !workspaceId) return null;

  const title = str(raw.title);
  const body = str(raw.body);
  const tabTitle = str(raw.tab_title);
  const createdAt = str(raw.created_at) || new Date(0).toISOString();

  return {
    id,
    agent: detectAgent(title),
    workspaceId,
    surfaceId: str(raw.surface_id) || undefined,
    repo: tabTitle || undefined,
    title: deriveTitle(tabTitle, body),
    reason: detectReason(body),
    body,
    createdAt,
  };
}

/** Normalize a raw notification array, dropping malformed rows. */
export function normalizeNotifications(raw: unknown): AttentionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AttentionItem[] = [];
  for (const row of raw) {
    if (row && typeof row === "object") {
      const item = normalizeNotification(row as RawCmuxNotification);
      if (item) out.push(item);
    }
  }
  return out;
}
