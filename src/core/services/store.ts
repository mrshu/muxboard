import type {
  AgentFilter,
  AppState,
  AttentionItem,
  ProviderUsage,
  WorkspaceStatus,
} from "../types.js";
import {
  applyFilter,
  clampOffset,
  dedupeNewestPerWorkspace,
  sortNewestFirst,
  triageOrder,
} from "../cmux/sort.js";

type Listener = (state: AppState) => void;

/** Cycle order for the agent filter (dial 2). */
const FILTER_CYCLE: AgentFilter[] = ["all", "claude", "codex", "pi"];

/** Number of LCD touch-strip segments (one per dial). */
const LCD_SEGMENTS = 4;

/** Wrap `n` into `[0, len)`; returns 0 when there is nothing to wrap into. */
function wrap(n: number, len: number): number {
  if (len <= 0) return 0;
  return ((n % len) + len) % len;
}

/**
 * In-memory application state with a tiny subscribe/emit API.
 *
 * The store is the single source of truth the Stream Deck actions render from.
 * Mutations recompute the derived `items` (filtered + sorted) and notify
 * subscribers; identical recomputations still emit so actions can re-render on
 * a forced refresh.
 */
export class Store {
  private state: AppState;
  private readonly listeners = new Set<Listener>();

  constructor(providers: string[] = []) {
    this.state = {
      items: [],
      allItems: [],
      offset: 0,
      filter: "all",
      cmuxOffline: false,
      usage: {},
      workspaceStatus: {},
      // Seeded empty; filled from CodexBar discovery on the first poll.
      providers: [...providers],
      providerOffset: 0,
      codexbarUpdatedAtMs: null,
      codexbarOffline: false,
    };
  }

  getState(): Readonly<AppState> {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /** Recompute filtered+sorted items and clamp the offset. */
  private recompute(): void {
    const allItems = sortNewestFirst(this.state.allItems);
    // Filter by agent, collapse to the newest item per workspace (one key per
    // repo), enrich with live event status, then pin exceptions
    // (failed/permission) to the front for triage. Enrichment happens BEFORE
    // triageOrder so an event-driven "working" sinks the pane correctly.
    const enriched = dedupeNewestPerWorkspace(applyFilter(allItems, this.state.filter)).map((it) =>
      this.applyStatus(it),
    );
    const items = triageOrder(enriched);
    const offset = clampOffset(this.state.offset, items.length);
    this.state = { ...this.state, allItems, items, offset };
  }

  /**
   * Overlay the live event-stream status onto an item: the authoritative
   * activity (running → working, else waiting) and the "since" timestamp that
   * drives the age. No event data → item is returned unchanged (the title-glyph
   * activity and notification createdAt remain the fallback).
   */
  private applyStatus(item: AttentionItem): AttentionItem {
    const st = this.state.workspaceStatus[item.workspaceId];
    if (!st && !item.busy) return item; // no live signal: keep the title-glyph fallback
    // "needs" (the agent is asking you for permission/input) takes priority so
    // it stays visible. Otherwise the pane is working if the agent is running
    // OR a command is crunching (busy) even though the agent itself went idle.
    const working = st?.state === "needs" ? false : st?.state === "running" || item.busy === true;
    return {
      ...item,
      activity: working ? "working" : "waiting",
      activitySince: st?.since ?? item.activitySince,
    };
  }

  /** Replace the cmux attention items (from a poll). */
  setAttention(items: AttentionItem[], offline: boolean): void {
    this.state = { ...this.state, allItems: items, cmuxOffline: offline };
    this.recompute();
    this.emit();
  }

  setCmuxOffline(offline: boolean): void {
    if (this.state.cmuxOffline === offline) return;
    this.state = { ...this.state, cmuxOffline: offline };
    this.emit();
  }

  /**
   * Replace the live per-workspace status (from the cmux event stream) and
   * re-enrich the visible items so activity/age reflect it immediately.
   */
  setWorkspaceStatus(workspaceStatus: Record<string, WorkspaceStatus>): void {
    this.state = { ...this.state, workspaceStatus };
    this.recompute();
    this.emit();
  }

  /**
   * Replace CodexBar usage. The provider display order is taken from the
   * discovered `usages` (so it's never hardcoded); on an offline poll the last
   * good usage and provider order are retained.
   */
  setUsage(usages: ProviderUsage[], updatedAtMs: number, offline: boolean): void {
    const usage: Record<string, ProviderUsage> = { ...this.state.usage };
    for (const u of usages) usage[u.provider] = u;
    const providers =
      offline || usages.length === 0 ? this.state.providers : usages.map((u) => u.provider);
    this.state = {
      ...this.state,
      usage,
      providers,
      // Keep the rotation offset valid as discovery changes the set: wrap it
      // into range, and pin to 0 once everything fits on screen again.
      providerOffset:
        providers.length > LCD_SEGMENTS ? wrap(this.state.providerOffset, providers.length) : 0,
      codexbarUpdatedAtMs: offline ? this.state.codexbarUpdatedAtMs : updatedAtMs,
      codexbarOffline: offline,
    };
    this.emit();
  }

  // ---- dial 1: scroll offset ------------------------------------------------
  scrollBy(delta: number): void {
    const offset = clampOffset(this.state.offset + delta, this.state.items.length);
    if (offset === this.state.offset) return;
    this.state = { ...this.state, offset };
    this.emit();
  }

  resetOffset(): void {
    if (this.state.offset === 0) return;
    this.state = { ...this.state, offset: 0 };
    this.emit();
  }

  /** The newest currently-visible item (slot 0), or null. */
  newestVisible(): AttentionItem | null {
    return this.state.items[this.state.offset] ?? this.state.items[0] ?? null;
  }

  // ---- dial 2: agent filter -------------------------------------------------
  cycleFilter(dir: 1 | -1): void {
    const i = FILTER_CYCLE.indexOf(this.state.filter);
    const next = FILTER_CYCLE[(i + dir + FILTER_CYCLE.length) % FILTER_CYCLE.length];
    this.state = { ...this.state, filter: next, offset: 0 };
    this.recompute();
    this.emit();
  }

  resetFilter(): void {
    if (this.state.filter === "all") return;
    this.state = { ...this.state, filter: "all", offset: 0 };
    this.recompute();
    this.emit();
  }

  // ---- dial 3: rotate the LCD provider window -------------------------------
  /**
   * Rotate which providers occupy the four LCD segments. A no-op unless there
   * are more providers than segments (otherwise all are already visible). The
   * offset wraps, so the window cycles endlessly in either direction.
   */
  rotateProviders(delta: number): void {
    if (this.state.providers.length <= LCD_SEGMENTS) return;
    const next = wrap(this.state.providerOffset + delta, this.state.providers.length);
    if (next === this.state.providerOffset) return;
    this.state = { ...this.state, providerOffset: next };
    this.emit();
  }

  /**
   * The provider id shown on each of the `count` LCD segments, applying the
   * rotation offset and wrapping. Segments beyond the provider count are
   * `undefined` (rendered as muted blanks).
   */
  visibleProviderWindow(count = LCD_SEGMENTS): (string | undefined)[] {
    const { providers, providerOffset } = this.state;
    const n = providers.length;
    return Array.from({ length: count }, (_, i) =>
      i < n ? providers[wrap(providerOffset + i, n)] : undefined,
    );
  }
}
