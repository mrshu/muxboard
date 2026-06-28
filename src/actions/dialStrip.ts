import streamDeck, {
  action,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DialRotateEvent,
  type DialDownEvent,
  type DialUpEvent,
  type TouchTapEvent,
  type DialAction,
} from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import type { Runtime } from "../runtime.js";
import { renderLcdSegments } from "../core/render/lcdRender.js";
import { isStale } from "../core/services/codexbarService.js";

const toDataUri = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/**
 * The Muxboard dial/touch-strip action (Stream Deck+ Encoder).
 *
 * One SingletonAction backs all four dials. Each segment shows one CodexBar
 * provider (provider 0..3, in config order). The column (0..3) selects the
 * dial's behavior:
 *   col 0  rotate=scroll attention      press=jump to newest
 *   col 1  rotate=cycle agent filter    press=reset filter
 *   col 2  rotate=toggle number mode    press=switch view (hold=CodexBar /usage)
 *   col 3  rotate=rotate providers       press=force refresh
 */
@action({ UUID: "com.mrshu.muxboard.dial" })
export class DialStripAction extends SingletonAction {
  private readonly runtime: Runtime;
  private readonly dials = new Map<string, DialAction>();
  private readonly lastSvg = new Map<string, string>();
  /** Pending col-2 hold timers (fire /usage while still pressed). */
  private readonly hold = new Map<string, ReturnType<typeof setTimeout>>();
  /** Dials whose hold already fired, so the release does nothing more. */
  private readonly consumed = new Set<string>();
  /** Hold this long on the col-2 dial to open /usage instead of switching view. */
  private static readonly HOLD_MS = 600;

  constructor(runtime: Runtime) {
    super();
    this.runtime = runtime;
    this.runtime.store.subscribe(() => this.renderAll());
  }

  override onWillAppear(ev: WillAppearEvent): void {
    const a = ev.action;
    if (!a.isDial()) return;
    this.dials.set(a.id, a);
    void a.setFeedbackLayout("layouts/segment.json").catch(() => {});
    this.renderOne(a);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const id = ev.action.id;
    this.dials.delete(id);
    this.lastSvg.delete(id);
    const timer = this.hold.get(id);
    if (timer) clearTimeout(timer);
    this.hold.delete(id);
    this.consumed.delete(id);
  }

  override onDialRotate(ev: DialRotateEvent): void {
    const col = ev.action.coordinates?.column ?? 0;
    const ticks = ev.payload.ticks;
    const dir = ticks >= 0 ? 1 : -1;
    switch (col) {
      case 0:
        this.runtime.store.scrollBy(ticks);
        break;
      case 1:
        this.runtime.store.cycleFilter(dir);
        break;
      case 2:
        // Toggle the quota rows between remaining% and the pace delta. One flip
        // per gesture (magnitude ignored) so a flick switches the view.
        this.runtime.store.cycleNumberMode();
        break;
      case 3:
        // Rotate the LCD provider window when there are more providers than
        // segments (a no-op otherwise). Multi-tick spins move proportionally.
        this.runtime.store.rotateProviders(ticks);
        break;
    }
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    const col = ev.action.coordinates?.column ?? 0;
    if (col === 2) {
      // col-2 push = switch board view (on release); hold 600ms = open /usage.
      // Mirrors the key long-press: a tap toggles, a hold does the heavier action.
      const id = ev.action.id;
      this.consumed.delete(id);
      const timer = setTimeout(() => {
        this.hold.delete(id);
        this.consumed.add(id);
        openUrl(
          `${this.runtime.config.codexbarBaseUrl.replace(/\/+$/, "")}/usage`,
          this.runtime.logger,
        );
      }, DialStripAction.HOLD_MS);
      this.hold.set(id, timer);
      return;
    }
    await this.handlePress(col, ev.action);
  }

  override onDialUp(ev: DialUpEvent): void {
    const id = ev.action.id;
    const timer = this.hold.get(id);
    if (timer) {
      clearTimeout(timer);
      this.hold.delete(id);
    }
    // The hold already opened /usage; the release does nothing more.
    if (this.consumed.delete(id)) return;
    if ((ev.action.coordinates?.column ?? 0) === 2) this.runtime.store.cycleView();
  }

  override async onTouchTap(ev: TouchTapEvent): Promise<void> {
    const col = ev.action.coordinates?.column ?? 0;
    // A touch on the col-2 segment is the quick "switch view" gesture too.
    if (col === 2) {
      this.runtime.store.cycleView();
      return;
    }
    await this.handlePress(col, ev.action);
  }

  private async handlePress(col: number, a: DialAction): Promise<void> {
    switch (col) {
      case 0: {
        // Jump to the newest visible attention item.
        const item = this.runtime.store.newestVisible();
        if (!item) return;
        try {
          await this.runtime.backends[item.source].focus(item);
        } catch (err) {
          this.runtime.logger.warn(`dial jump failed: ${message(err)}`);
          await a.showAlert();
        }
        break;
      }
      case 1:
        this.runtime.store.resetFilter();
        break;
      // col 2 (switch view / hold = /usage) is handled in onDialDown/onDialUp +
      // onTouchTap, so it never reaches handlePress.
      case 3: {
        // Force-refresh every active source. Only poll Orca when it's running
        // (auto-detected), so a cmux-only user doesn't trigger a failing CLI call.
        const polls = [this.runtime.cmuxService.poll(), this.runtime.codexbarService.poll()];
        if (this.runtime.store.getState().orcaActive) polls.push(this.runtime.orcaService.poll());
        await Promise.allSettled(polls);
        break;
      }
    }
  }

  private renderAll(): void {
    for (const a of this.dials.values()) this.renderOne(a);
  }

  private renderOne(a: DialAction): void {
    const col = a.coordinates?.column ?? 0;
    const state = this.runtime.store.getState();
    const stale = isStale(
      state.codexbarUpdatedAtMs,
      Date.now(),
      this.runtime.codexbarService.staleThresholdMs,
    );
    // One provider per segment, in display order with the dial-3 rotation
    // offset applied, so a list longer than four segments can be scrolled through.
    const usages = this.runtime.store
      .visibleProviderWindow()
      .map((p) => (p ? state.usage[p] : undefined));
    const segments = renderLcdSegments(usages, {
      nowMs: Date.now(),
      stale,
      numberMode: state.lcdNumberMode,
    });
    const svg = segments[col] ?? segments[0];

    if (this.lastSvg.get(a.id) === svg) return; // debounce
    this.lastSvg.set(a.id, svg);
    void a.setFeedback({ full: { value: toDataUri(svg) } }).catch((err) =>
      streamDeck.logger.warn(`setFeedback failed: ${message(err)}`),
    );
  }
}

function openUrl(url: string, logger: { warn(m: string): void }): void {
  execFile("open", [url], (err) => {
    if (err) logger.warn(`open ${url} failed: ${err.message}`);
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
