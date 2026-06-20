import type {
  AgentFilter,
  AppState,
  AttentionItem,
  ProviderUsage,
} from "../types.js";
import { applyFilter, clampOffset, sortNewestFirst } from "../cmux/sort.js";

type Listener = (state: AppState) => void;

/** Cycle order for the agent filter (dial 2). */
const FILTER_CYCLE: AgentFilter[] = ["all", "claude", "codex", "pi"];

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

  constructor(providers: string[]) {
    this.state = {
      items: [],
      allItems: [],
      offset: 0,
      filter: "all",
      cmuxOffline: false,
      usage: {},
      providers: providers.length > 0 ? [...providers] : ["codex"],
      providerIndex: 0,
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
    const items = applyFilter(allItems, this.state.filter);
    const offset = clampOffset(this.state.offset, items.length);
    this.state = { ...this.state, allItems, items, offset };
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

  /** Replace CodexBar usage for the polled providers. */
  setUsage(usages: ProviderUsage[], updatedAtMs: number, offline: boolean): void {
    const usage: Record<string, ProviderUsage> = { ...this.state.usage };
    for (const u of usages) usage[u.provider] = u;
    this.state = {
      ...this.state,
      usage,
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

  // ---- dial 3: provider selection ------------------------------------------
  cycleProvider(dir: 1 | -1): void {
    const n = this.state.providers.length;
    if (n <= 1) return;
    const providerIndex = (this.state.providerIndex + dir + n) % n;
    this.state = { ...this.state, providerIndex };
    this.emit();
  }

  /** The provider currently shown on the LCD. */
  currentProvider(): string {
    return this.state.providers[this.state.providerIndex] ?? this.state.providers[0] ?? "codex";
  }

  currentUsage(): ProviderUsage | undefined {
    return this.state.usage[this.currentProvider()];
  }
}
