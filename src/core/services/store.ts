import type {
  AgentFilter,
  AppState,
  AttentionItem,
  AttentionSource,
  ProviderUsage,
  WorkspaceStatus,
} from "../types.js";
import {
  applyFilter,
  clampOffset,
  dedupeNewestPerWorkspace,
  isDecision,
  sortNewestFirst,
  triageOrder,
} from "../cmux/sort.js";

type Listener = (state: AppState) => void;

/** Cycle order for the agent filter (dial 2). */
const FILTER_CYCLE: AgentFilter[] = ["all", "claude", "codex", "pi"];

/** Number of LCD touch-strip segments (one per dial). */
const LCD_SEGMENTS = 4;

/** A "working" pane with no events for this long (and not CPU-busy) reads as stalled. */
const STALLED_MS = 180_000;

/** Wrap `n` into `[0, len)`; returns 0 when there is nothing to wrap into. */
function wrap(n: number, len: number): number {
  if (len <= 0) return 0;
  return ((n % len) + len) % len;
}

/** Shallow equality for a {workspaceId: epochMs} map. */
function sameNumberMap(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
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
  /** Raw attention items per source, merged into allItems on recompute. */
  private itemsBySource: Record<AttentionSource, AttentionItem[]> = { cmux: [], orca: [] };
  /** Epoch ms per workspace of the user's latest cmux "clear notifications". */
  private clearedNotifications: Record<string, number> = {};
  /** workspaceId → epoch ms until which the user has snoozed it (long-press). */
  private readonly snoozed = new Map<string, number>();
  private readonly now: () => number;

  constructor(providers: string[] = [], now: () => number = () => Date.now()) {
    this.now = now;
    this.state = {
      items: [],
      allItems: [],
      offset: 0,
      filter: "all",
      view: "queue",
      lcdNumberMode: "remaining",
      cmuxOffline: false,
      orcaOffline: false,
      orcaActive: false,
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
    // Drop any cmux key the user explicitly cleared in cmux (live event-stream
    // signal), so it vanishes immediately rather than lingering until the next
    // poll drops it from the notification list.
    const cmux = this.itemsBySource.cmux.filter((it) => !this.isCleared(it));
    const merged = [...cmux, ...this.itemsBySource.orca];
    const allItems = sortNewestFirst(merged);
    // Filter by agent, collapse to the newest item per workspace (one key per
    // repo), enrich with live event status, then pin exceptions
    // (failed/permission) to the front for triage. Enrichment happens BEFORE
    // triageOrder so an event-driven "working" sinks the pane correctly.
    const enriched = dedupeNewestPerWorkspace(applyFilter(allItems, this.state.filter))
      // Drop snoozed workspaces (long-press) until their window passes; an
      // expired snooze auto-reverts here so the item silently returns.
      .filter((it) => !this.isSnoozed(it))
      .map((it) => this.applyStatus(it))
      // A synthetic "running" pane is only listed while it's actually working;
      // once the live status says otherwise, drop it (a real notification will
      // cover it if it then needs you).
      .filter((it) => !it.synthetic || it.activity === "working");
    const triaged = triageOrder(enriched);
    // The Decisions view (col-2 push) shows only the panes that want a human
    // now (failed/permission/needs-input), dropping working/waiting tiles.
    const items = this.state.view === "decisions" ? triaged.filter(isDecision) : triaged;
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
    // The live status overlay and busy signal come from the cmux event stream,
    // keyed by cmux workspace id. Orca items must never be touched by it, even
    // if a worktree id ever collided with a cmux id.
    if (item.source !== "cmux") return item;
    const st = this.state.workspaceStatus[item.workspaceId];
    if (!st && !item.busy) return item; // no live signal: keep the title-glyph fallback
    // "needs" (the agent is asking you for permission/input) takes priority so
    // it stays visible. Otherwise the pane is working if the agent is running
    // OR a command is crunching (busy) even though the agent itself went idle.
    const working = st?.state === "needs" ? false : st?.state === "running" || item.busy === true;
    // Age clock = the MOST RECENT evidence of the current state. A live busy-since
    // beats a stale agent-event since, so an active pane never reads "working 10h"
    // when the hook stream froze hours ago.
    const sinces: number[] = [];
    if (st) sinces.push(st.since);
    if (item.busy && item.busySince != null) sinces.push(item.busySince);
    const activitySince = sinces.length ? Math.max(...sinces) : item.activitySince;
    // Stalled = a running pane that has gone silent past the threshold and isn't
    // CPU-busy (a busy command is genuine work, not a hang). lastSeen advances on
    // every event, so a healthy long turn stays fresh while a hung one goes stale.
    const lastSeen = st?.lastSeen;
    const stalled =
      working && item.busy !== true && lastSeen != null && this.now() - lastSeen > STALLED_MS
        ? (true as const)
        : undefined;
    return {
      ...item,
      activity: working ? "working" : "waiting",
      activitySince,
      needsInput: st?.state === "needs" || undefined,
      stalled,
    };
  }

  /**
   * True when the user cleared this cmux workspace's notifications at or after
   * the item fired — i.e. they explicitly dismissed exactly this prompt. A
   * re-ask (a newer notification) survives because its createdAt is past the
   * clear time.
   *
   * Only real notification items are eligible. A synthetic "running" pane is a
   * live "agent working right now" indicator (not a notification), and its
   * createdAt is the poll time, which races against the clear timestamp — a busy
   * agent that clears its own notifications many times a second would otherwise
   * make the pane flicker on and off between polls. A notification-clear must
   * never hide a working pane. Orca items and bad/missing createdAt are also
   * never dropped.
   */
  private isCleared(item: AttentionItem): boolean {
    if (item.source !== "cmux" || item.synthetic) return false;
    const at = this.clearedNotifications[item.workspaceId];
    if (at == null) return false;
    const created = Date.parse(item.createdAt);
    return !Number.isNaN(created) && created <= at;
  }

  /**
   * True while the user has snoozed this workspace (long-press) and the window
   * hasn't elapsed. An expired snooze is pruned here so the item auto-reverts
   * into the queue on the next recompute (poll/event), "not now but don't forget".
   */
  private isSnoozed(item: AttentionItem): boolean {
    const until = this.snoozed.get(item.workspaceId);
    if (until == null) return false;
    if (this.now() < until) return true;
    this.snoozed.delete(item.workspaceId);
    return false;
  }

  /** Snooze a workspace's keys for `ms`; it returns automatically when elapsed. */
  snooze(workspaceId: string, ms: number): void {
    this.snoozed.set(workspaceId, this.now() + ms);
    this.recompute();
    this.emit();
  }

  /**
   * Record the live per-workspace "clear notifications" times (from the cmux
   * event stream) and drop any now-cleared key immediately. A no-op when nothing
   * changed, so the far-more-frequent status updates don't pay for a recompute.
   */
  setClearedNotifications(cleared: Record<string, number>): void {
    if (sameNumberMap(this.clearedNotifications, cleared)) return;
    this.clearedNotifications = cleared;
    this.recompute();
    this.emit();
  }

  /** Replace one source's attention items (from its poll). */
  setAttention(items: AttentionItem[], offline: boolean, source: AttentionSource = "cmux"): void {
    this.itemsBySource[source] = items;
    const offlineField = source === "cmux" ? "cmuxOffline" : "orcaOffline";
    this.state = { ...this.state, [offlineField]: offline };
    this.recompute();
    this.emit();
  }

  /** Mark a single source offline/online without replacing its items. */
  setSourceOffline(source: AttentionSource, offline: boolean): void {
    const field = source === "cmux" ? "cmuxOffline" : "orcaOffline";
    if (this.state[field] === offline) return;
    this.state = { ...this.state, [field]: offline };
    this.emit();
  }

  /** Mark the Orca poller as active (auto-detected reachable and started). */
  setOrcaActive(active: boolean): void {
    if (this.state.orcaActive === active) return;
    this.state = { ...this.state, orcaActive: active };
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

  // ---- col-2 push: toggle the board view (queue <-> decisions) --------------
  /**
   * Flip the 8-key board between the full triage queue and the Decisions view
   * (only failed/permission/needs-input). Resets the scroll offset and
   * recomputes since the visible set changes. With two views every push is its
   * own undo; it is seeded "queue" and not persisted across reloads.
   */
  cycleView(): void {
    const next = this.state.view === "queue" ? "decisions" : "queue";
    this.state = { ...this.state, view: next, offset: 0 };
    this.recompute();
    this.emit();
  }

  // ---- rightmost dial: toggle the LCD quota number mode ---------------------
  /**
   * Flip the LCD quota rows between showing absolute remaining% and the signed
   * pace delta (reserve/deficit). One toggle per rotate gesture; with two modes
   * the direction doesn't matter.
   */
  cycleNumberMode(): void {
    const next = this.state.lcdNumberMode === "remaining" ? "pace" : "remaining";
    this.state = { ...this.state, lcdNumberMode: next };
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
