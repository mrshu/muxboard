import streamDeck from "@elgato/streamdeck";
import { message } from "../core/services/logger.js";

/**
 * Per-instance SVG write cache shared by the key and dial actions. Skips a
 * write whose SVG is unchanged (flicker debounce), and rolls the entry back on
 * failure so the next store emit retries instead of leaving the surface stale
 * until its content happens to change. The rollback is guarded so a late
 * failure never clobbers a newer render's entry.
 */
export class SvgCache {
  private readonly last = new Map<string, string>();

  forget(id: string): void {
    this.last.delete(id);
  }

  write(id: string, svg: string, send: (uri: string) => Promise<unknown>, what: string): void {
    if (this.last.get(id) === svg) return;
    this.last.set(id, svg);
    void send(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`).catch((err) => {
      if (this.last.get(id) === svg) this.last.delete(id);
      streamDeck.logger.warn(`${what} failed: ${message(err)}`);
    });
  }
}

/**
 * Press-and-hold bookkeeping shared by the key and dial actions. The hold fires
 * while the surface is still pressed, so the eventual release must become a
 * no-op: arm() on down, release() on up (true = the hold already fired), and
 * release() again on disappear to drop a still-pending timer.
 */
export class HoldTimer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fired = new Set<string>();

  arm(id: string, ms: number, run: () => void): void {
    this.fired.delete(id);
    const t = setTimeout(() => {
      this.timers.delete(id);
      this.fired.add(id);
      run();
    }, ms);
    this.timers.set(id, t);
  }

  /** Cancel a pending hold; true when the hold already fired. */
  release(id: string): boolean {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    return this.fired.delete(id);
  }
}
