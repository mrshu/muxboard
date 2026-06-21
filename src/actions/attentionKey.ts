import streamDeck, {
  action,
  SingletonAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
  type KeyAction,
} from "@elgato/streamdeck";
import type { Runtime } from "../runtime.js";
import { bringCmuxToFront } from "../runtime.js";
import { assignSlots, coordinatesToSlot } from "../core/cmux/sort.js";
import { renderKey, renderEmptyKey, renderCmuxOffline } from "../core/render/keyRender.js";
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
    this.keys.delete(ev.action.id);
    this.lastSvg.delete(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const item = this.itemForAction(ev.action);
    if (!item) return; // empty slot: nothing to focus

    bringCmuxToFront(this.runtime.logger);
    // A synthetic "running" pane has no notification id; focus its workspace.
    if (item.synthetic) {
      try {
        await this.runtime.cmux.selectWorkspace(item.workspaceId);
      } catch (err) {
        this.runtime.logger.warn(`focus running pane failed: ${message(err)}`);
        await ev.action.showAlert();
      }
      return;
    }
    try {
      await this.runtime.cmux.openNotification(item.id);
    } catch (err) {
      this.runtime.logger.warn(`open-notification failed, falling back: ${message(err)}`);
      try {
        await this.runtime.cmux.selectWorkspace(item.workspaceId);
      } catch (err2) {
        this.runtime.logger.error(`focus fallback failed: ${message(err2)}`);
        await ev.action.showAlert();
        return;
      }
    }
    this.runtime.markOpened(item.id);
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
    if (state.cmuxOffline && slot === 0 && state.items.length === 0) {
      svg = renderCmuxOffline();
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
