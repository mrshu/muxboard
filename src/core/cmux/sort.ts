import type { AgentFilter, AttentionItem } from "../types.js";

/** Number of physical keys on a Stream Deck+. */
export const KEY_COUNT = 8;

/** Parse an ISO timestamp to epoch ms, treating unparseable values as oldest. */
function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Sort attention items newest-first by createdAt.
 *
 * Ties (or unparseable timestamps) fall back to id for a stable, deterministic
 * order so the same input always produces the same key layout.
 */
export function sortNewestFirst(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const diff = toMs(b.createdAt) - toMs(a.createdAt);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Apply the agent filter (dial 2). "all" passes everything through. */
export function applyFilter(items: AttentionItem[], filter: AgentFilter): AttentionItem[] {
  if (filter === "all") return items;
  return items.filter((it) => it.agent === filter);
}

/** Triage rank: failed first, then blocked (needs permission), then the rest. */
function reasonRank(reason: AttentionItem["reason"]): number {
  if (reason === "failed") return 0;
  if (reason === "blocked") return 1;
  return 2;
}

/**
 * Order for the key grid: exceptions (failed/permission) pinned to the front so
 * the few urgent items land top-left, then everything else in the given order
 * (newest-first). Array.sort is stable, so within a rank the input order holds.
 */
export function triageOrder(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => reasonRank(a.reason) - reasonRank(b.reason));
}

/**
 * Collapse to one item per workspace, keeping the newest.
 *
 * cmux accumulates a notification per agent turn, so a single workspace can have
 * many (e.g. a "done" then a "waiting"). Given a newest-first list, this keeps
 * only the first (latest) per workspace — so each repo occupies one key showing
 * its current state, instead of several stale duplicates.
 */
export function dedupeNewestPerWorkspace(sortedNewestFirst: AttentionItem[]): AttentionItem[] {
  const seen = new Set<string>();
  const out: AttentionItem[] = [];
  for (const it of sortedNewestFirst) {
    if (seen.has(it.workspaceId)) continue;
    seen.add(it.workspaceId);
    out.push(it);
  }
  return out;
}

/**
 * Assign sorted items to the 8 physical key slots.
 *
 * Physical layout is:
 *   slot 0 1 2 3   (keys 1 2 3 4)
 *   slot 4 5 6 7   (keys 5 6 7 8)
 *
 * `offset` shifts the visible window when there are more than 8 items. The
 * result always has exactly KEY_COUNT entries; empty slots are null.
 */
export function assignSlots(
  sortedItems: AttentionItem[],
  offset = 0,
): (AttentionItem | null)[] {
  const slots: (AttentionItem | null)[] = new Array(KEY_COUNT).fill(null);
  const start = clampOffset(offset, sortedItems.length);
  for (let i = 0; i < KEY_COUNT; i++) {
    slots[i] = sortedItems[start + i] ?? null;
  }
  return slots;
}

/**
 * Clamp a scroll offset so the visible window always shows real items when any
 * exist. Offsets that would scroll past the end snap back to the last full-ish
 * page; negative offsets snap to 0.
 */
export function clampOffset(offset: number, total: number): number {
  if (total <= KEY_COUNT) return 0;
  const max = total - 1; // allow scrolling until the last item sits in slot 0
  if (offset < 0) return 0;
  if (offset > max) return max;
  return offset;
}

/**
 * Map a Stream Deck key coordinate to a slot index for the 4×2 keypad.
 *
 * Stream Deck+ keypad coordinates are { column: 0..3, row: 0..1 }.
 */
export function coordinatesToSlot(column: number, row: number): number {
  return row * 4 + column;
}
