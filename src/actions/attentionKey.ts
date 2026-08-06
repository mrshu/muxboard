import {
  action,
  SingletonAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
  type KeyAction,
} from "@elgato/streamdeck";
import type { Runtime } from "../runtime.js";
import { assignSlots, coordinatesToSlot, itemRank, KEY_COUNT } from "../core/cmux/sort.js";
import { renderKey, renderEmptyKey, renderAllClear, renderOverflow, renderPagerHome, renderSourceOffline } from "../core/render/keyRender.js";
import type { AttentionItem } from "../core/types.js";
import { HoldTimer, SvgCache } from "./svgCache.js";
import { message } from "../core/services/logger.js";

/**
 * The Attention Slot key action.
 *
 * One SingletonAction handles all 8 key instances; each is distinguished by its
 * coordinates → slot. The action subscribes to the store once and re-renders
 * every appeared key whenever state changes, caching the last SVG per instance
 * to avoid redundant setImage calls (flicker/debounce).
 */
@action({ UUID: "com.mrshu.muxboard.attention" })
export class AttentionKeyAction extends SingletonAction {
  private readonly runtime: Runtime;
  /** Appeared key instances by action id. */
  private readonly keys = new Map<string, KeyAction>();
  /** Last rendered SVG per action id, to skip no-op redraws. */
  private readonly svgCache = new SvgCache();
  /** Long-press bookkeeping (fires the snooze while the key is still held). */
  private readonly holds = new HoldTimer();
  /** Hold this long to snooze the notification instead of focusing it. */
  private static readonly LONG_PRESS_MS = 600;
  /** How long a long-press snoozes a workspace before it auto-reverts. */
  private static readonly SNOOZE_MS = 5 * 60 * 1000;

  constructor(runtime: Runtime) {
    super();
    this.runtime = runtime;
    this.runtime.store.subscribe(() => this.renderAll());
  }

  override onWillAppear(ev: WillAppearEvent): void {
    const a = ev.action;
    if (!a.isKey()) return;
    this.keys.set(a.id, a);
    this.renderOne(a);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const id = ev.action.id;
    this.keys.delete(id);
    this.svgCache.forget(id);
    this.holds.release(id);
  }

  override onKeyDown(ev: KeyDownEvent): void {
    // Drop any stale hold before the early-returns below: if the SDK ever loses
    // a keyUp, the next press self-heals instead of being silently swallowed.
    this.holds.release(ev.action.id);
    const slot = ev.action.isKey() ? this.slotOf(ev.action) : null;
    if (slot !== null && this.isPager(slot)) return; // pager: paged on release, no snooze
    const item = this.itemForAction(ev.action);
    // Arm a long-press snooze for real notifications: it fires while the key is
    // still held (instant ✓), and the eventual release becomes a no-op. A tap
    // (release before the threshold) cancels it and focuses instead.
    if (item && !item.synthetic && ev.action.isKey()) {
      const action = ev.action;
      this.holds.arm(ev.action.id, AttentionKeyAction.LONG_PRESS_MS, () =>
        void this.snooze(item, action),
      );
    }
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    // The long-press already snoozed on hold; the release does nothing more.
    if (this.holds.release(ev.action.id)) return;
    const slot = this.slotOf(ev.action);
    const state = this.runtime.store.getState();
    if (slot !== null && this.isPager(slot, state)) {
      // Pager tap: reveal the next screen, or return to the top on the last page.
      const hiddenBelow = state.items.length - (state.offset + (KEY_COUNT - 1));
      if (hiddenBelow > 0) this.runtime.store.pageForward();
      else this.runtime.store.resetOffset();
      return;
    }
    const item = this.itemForAction(ev.action);
    if (item) await this.focus(item, ev.action);
  }

  /**
   * Long-press: snooze the workspace locally for a bounded window, then it
   * auto-reverts into the queue ("not now, but don't let me forget"). We do NOT
   * tell the backend to dismiss — a true clear happens when the agent resolves
   * or the user clears it in cmux (honored via the cleared-notification path),
   * so nothing can be permanently lost by a press.
   */
  private async snooze(item: AttentionItem, action: KeyAction): Promise<void> {
    this.runtime.store.snooze(item.workspaceId, AttentionKeyAction.SNOOZE_MS);
    await action.showOk();
  }

  /** Bring the source app forward and jump to the pane (tap behavior). */
  private async focus(item: AttentionItem, action: KeyAction): Promise<void> {
    try {
      await this.runtime.backends[item.source].focus(item);
    } catch (err) {
      this.runtime.logger.error(`focus failed: ${message(err)}`);
      await action.showAlert();
    }
  }

  /** Re-render every appeared key from current state. */
  private renderAll(): void {
    for (const a of this.keys.values()) this.renderOne(a);
  }

  private slotOf(a: KeyAction): number | null {
    const c = a.coordinates;
    if (!c) return null;
    return coordinatesToSlot(c.column, c.row);
  }

  /** True when this slot is the overflow pager: the last key while the queue overflows. */
  private isPager(slot: number, state = this.runtime.store.getState()): boolean {
    return state.items.length > KEY_COUNT && slot === KEY_COUNT - 1;
  }

  private itemForAction(a: KeyAction): AttentionItem | null {
    const slot = this.slotOf(a);
    if (slot === null) return null;
    const { items, offset } = this.runtime.store.getState();
    return assignSlots(items, offset)[slot] ?? null;
  }

  private renderOne(a: KeyAction): void {
    const slot = this.slotOf(a);
    if (slot === null) return;
    const state = this.runtime.store.getState();

    let svg: string;
    // Tile only when every ACTIVE source is offline (an inactive Orca, which
    // never started, doesn't keep the board blank when cmux is down).
    const allDown = state.cmuxOffline && (!state.orcaActive || state.orcaOffline);
    const decisions = state.view === "decisions";
    // The index shows the item's ABSOLUTE position in the queue, not the
    // physical key — so scrolling (col-0 dial) reveals 9, 10, 11… and you can
    // see how deep into a long queue this key is. Hidden until you actually
    // scroll (offset 0 → no number), so the resting board stays uncluttered.
    const queuePos = state.offset > 0 ? state.offset + slot + 1 : undefined;
    if (allDown && slot === 0 && state.items.length === 0) {
      // allDown implies cmux is down; orca joins the label only when it's active.
      svg = renderSourceOffline(state.orcaActive && state.orcaOffline ? "cmux + orca" : "cmux");
    } else if (decisions && state.items.length === 0 && !allDown) {
      // Decisions view, nothing pending: a calm "all clear" tile, not blank dots.
      svg = slot === 0 ? renderAllClear("no decisions") : renderEmptyKey(slot + 1);
    } else if (this.isPager(slot, state)) {
      // The last key is the pager whenever the queue overflows (so 7 agents show
      // per page). It shows "+N more" tinted by the worst hidden item, or "↑ top"
      // on the last page — tap to page forward / return to the top.
      const hidden = state.items.slice(state.offset + KEY_COUNT - 1);
      svg = hidden.length > 0 ? renderOverflow(hidden.length, overflowAccent(hidden)) : renderPagerHome();
    } else {
      const item = assignSlots(state.items, state.offset)[slot];
      svg = item
        ? renderKey(item, { nowMs: Date.now(), slotNumber: queuePos, viewBadge: decisions ? "DEC" : undefined })
        : renderEmptyKey(slot + 1);
    }

    this.svgCache.write(a.id, svg, (uri) => a.setImage(uri), "setImage");
  }
}

/** Border tint for the "+N more" tile = the most-severe hidden item's color. */
function overflowAccent(items: AttentionItem[]): string {
  const color: Record<number, string> = { 0: "#ff4d4f", 1: "#ffb02e", 2: "#38bdf8", 3: "#e0852b" };
  // Ranks 4/5 (plain waiting, working) have no accent -> neutral fallback.
  return color[Math.min(...items.map(itemRank))] ?? "#7d8794";
}
