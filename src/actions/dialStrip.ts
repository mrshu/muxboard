import streamDeck, {
  action,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DialRotateEvent,
  type DialDownEvent,
  type TouchTapEvent,
  type DialAction,
} from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import type { Runtime } from "../runtime.js";
import { bringCmuxToFront } from "../runtime.js";
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
 *   col 2  (rotate unused)              press=open CodexBar source
 *   col 3  (rotate unused)              press=force refresh
 */
@action({ UUID: "com.mrshu.muxboard.dial" })
export class DialStripAction extends SingletonAction {
  private readonly runtime: Runtime;
  private readonly dials = new Map<string, DialAction>();
  private readonly lastSvg = new Map<string, string>();

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
    this.dials.delete(ev.action.id);
    this.lastSvg.delete(ev.action.id);
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
      // cols 2 & 3: rotation unused (each segment is a fixed provider)
    }
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    await this.handlePress(ev.action.coordinates?.column ?? 0, ev.action);
  }

  override async onTouchTap(ev: TouchTapEvent): Promise<void> {
    await this.handlePress(ev.action.coordinates?.column ?? 0, ev.action);
  }

  private async handlePress(col: number, a: DialAction): Promise<void> {
    switch (col) {
      case 0: {
        // Jump to the newest visible attention item.
        const item = this.runtime.store.newestVisible();
        if (!item) return;
        bringCmuxToFront(this.runtime.logger);
        try {
          await this.runtime.cmux.openNotification(item.id);
          this.runtime.markOpened(item.id);
        } catch (err) {
          this.runtime.logger.warn(`dial jump failed: ${message(err)}`);
          await a.showAlert();
        }
        break;
      }
      case 1:
        this.runtime.store.resetFilter();
        break;
      case 2:
        // Open the CodexBar source (its served base URL) if possible.
        openUrl(this.runtime.config.codexbarBaseUrl, this.runtime.logger);
        break;
      case 3:
        await Promise.allSettled([
          this.runtime.cmuxService.poll(),
          this.runtime.codexbarService.poll(),
        ]);
        break;
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
    // One provider per segment, in config order, so all are visible at a glance.
    const usages = state.providers.map((p) => state.usage[p]);
    const segments = renderLcdSegments(usages, { nowMs: Date.now(), stale });
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
