import streamDeck, {
  action,
  SingletonAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
  type KeyAction,
} from "@elgato/streamdeck";
import type { Runtime } from "../runtime.js";
import { assignSlots, coordinatesToSlot } from "../core/cmux/sort.js";
import { renderKey, renderEmptyKey, renderSourceOffline } from "../core/render/keyRender.js";
import type { AttentionItem } from "../core/types.js";

const toDataUri = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

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
  private readonly lastSvg = new Map<string, string>();
  /** Pending long-press timers per key (fire the dismiss while still held). */
  private readonly longPress = new Map<string, ReturnType<typeof setTimeout>>();
  /** Keys whose long-press already fired, so the release does nothing more. */
  private readonly consumed = new Set<string>();
  /** Hold this long to dismiss the notification instead of focusing it. */
  private static readonly LONG_PRESS_MS = 600;

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
    this.lastSvg.delete(id);
    const timer = this.longPress.get(id);
    if (timer) clearTimeout(timer);
    this.longPress.delete(id);
    this.consumed.delete(id);
  }

  override onKeyDown(ev: KeyDownEvent): void {
    const id = ev.action.id;
    this.consumed.delete(id);
    const item = this.itemForAction(ev.action);
    // Arm a long-press dismiss for real notifications: it fires while the key is
    // still held (instant ✓), and the eventual release becomes a no-op. A tap
    // (release before the threshold) cancels it and focuses instead.
    if (item && !item.synthetic && ev.action.isKey()) {
      const action = ev.action;
      const timer = setTimeout(() => {
        this.longPress.delete(id);
        this.consumed.add(id);
        void this.dismiss(item, action);
      }, AttentionKeyAction.LONG_PRESS_MS);
      this.longPress.set(id, timer);
    }
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    const id = ev.action.id;
    const timer = this.longPress.get(id);
    if (timer) {
      clearTimeout(timer);
      this.longPress.delete(id);
    }
    // The long-press already dismissed on hold; the release does nothing more.
    if (this.consumed.delete(id)) return;
    const item = this.itemForAction(ev.action);
    if (item) await this.focus(item, ev.action);
  }

  /** Long-press: cmux removes the notification; Orca re-focuses the worktree. */
  private async dismiss(item: AttentionItem, action: KeyAction): Promise<void> {
    try {
      await this.runtime.backends[item.source].dismiss(item);
      await action.showOk();
    } catch (err) {
      this.runtime.logger.warn(`dismiss failed: ${message(err)}`);
      await action.showAlert();
    }
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
    const cmuxDown = state.cmuxOffline;
    const orcaDown = !state.orcaActive || state.orcaOffline;
    // Tile only when every ACTIVE source is offline (an inactive Orca, which
    // never started, doesn't keep the board blank when cmux is down).
    const allDown = cmuxDown && orcaDown;
    if (allDown && slot === 0 && state.items.length === 0) {
      const labels = [state.cmuxOffline ? "cmux" : null, state.orcaActive && state.orcaOffline ? "orca" : null].filter(Boolean);
      svg = renderSourceOffline(labels.join(" + "));
    } else {
      const item = assignSlots(state.items, state.offset)[slot];
      svg = item
        ? renderKey(item, { nowMs: Date.now(), slotNumber: slot + 1 })
        : renderEmptyKey(slot + 1);
    }

    if (this.lastSvg.get(a.id) === svg) return; // debounce: no change
    this.lastSvg.set(a.id, svg);
    void a.setImage(toDataUri(svg)).catch((err) =>
      streamDeck.logger.warn(`setImage failed: ${message(err)}`),
    );
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
