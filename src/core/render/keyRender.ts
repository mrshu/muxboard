import type { AttentionItem } from "../types.js";
import { agentTheme } from "./palette.js";
import { escapeXml, estTextWidth, fitText, formatAgeFromSeconds } from "./format.js";
import { providerIconSvg } from "./providerIcons.js";
import { sourceGlyphSvg, sourceTint } from "./sourceIcons.js";

/** Key canvas size. Stream Deck keys are 72pt; we render @2x for crispness. */
export const KEY_SIZE = 144;

export interface KeyRenderOptions {
  /** Epoch ms used to compute age. */
  nowMs: number;
  /** Absolute 1-based queue position, shown beside the icon only while scrolled. Omit to hide it. */
  slotNumber?: number;
  /** Optional active-view tag (e.g. "DEC") drawn top-center so a non-default board is never a hidden mode. */
  viewBadge?: string;
}

/**
 * Per-state treatment for the status line and the border. A state urgent enough
 * to own the border paints it in its own label color, so the two can never drift
 * apart; the widths are a non-linear ramp so thickness tracks triage rank — the
 * single most dangerous (failed) tile visibly out-shouts blocked/needs, which in
 * turn out-shout a plain colored key. A zero width falls back to the workspace color.
 */
const STATUS_STYLES = {
  stalled: { text: "◷ STALLED", color: "#e0852b", borderW: 7 }, // amber-orange: a working pane gone silent
  working: { text: "● working", color: "#4ec9b0", borderW: 0 }, // busy again: keeps the workspace color
  failed: { text: "✕ FAILED", color: "#ff4d4f", borderW: 10 },
  blocked: { text: "PERMISSION", color: "#ffb02e", borderW: 7 },
  needs: { text: "◆ NEEDS YOU", color: "#38bdf8", borderW: 6 }, // cyan: distinct from blocked's amber
  waiting: { text: "waiting", color: "#9aa0aa", borderW: 0 },
} as const;

/** Age → {fontSize, color}: older waits read bigger and warmer (urgency). */
function ageStyle(ageSeconds: number): { size: number; color: string } {
  if (ageSeconds < 300) return { size: 20, color: "#7f8794" }; // <5m: calm grey
  if (ageSeconds < 1800) return { size: 24, color: "#b9c0a8" }; // <30m: pale
  if (ageSeconds < 7200) return { size: 28, color: "#ffce5a" }; // <2h: amber
  return { size: 30, color: "#ff8a4d" }; // older: hot orange
}

/**
 * Render an attention item to an SVG string for a Stream Deck key.
 *
 * Layout (144×144): the session TITLE is the hero — auto-fit (shrink + wrap) so
 * it shows in full. Agent brand icon top-left, age top-right (warmth-ramped =
 * urgency). Failed/blocked add a colored border + a small reason chip at the
 * bottom so the rare urgent tiles pop.
 */
export function renderKey(item: AttentionItem, opts: KeyRenderOptions): string {
  const a = agentTheme(item.agent);
  // Age clock: prefer the live activity start (from the cmux event stream) so a
  // key reads "working for 2m" / "waiting since X", not the age of a stale
  // notification. Fall back to the notification createdAt when no event data.
  const parsedSince = item.activitySince ?? Date.parse(item.createdAt);
  // An unparseable timestamp must not flow into the age math: NaN would render
  // as literal "NaNd" in the OLDEST (hottest) style — the most urgent look for
  // the one tile we know nothing about. Show a neutral "?" in the calm style
  // instead, matching formatAge's guard and sort.ts's toMs fallback.
  const unknownAge = Number.isNaN(parsedSince);
  const ageSeconds = unknownAge ? 0 : Math.max(0, Math.floor((opts.nowMs - parsedSince) / 1000));
  const age = unknownAge ? "?" : formatAgeFromSeconds(ageSeconds);
  const ageS = ageStyle(ageSeconds);
  const S = KEY_SIZE;

  // Top row: the slot index (left, just after the icon chip) and the age (right,
  // right-anchored at S-12) share the same band and grow toward each other. Shrink
  // the index font until it clears the age's estimated left edge by an 8px gap; if
  // a pathological "#128" beside a wide "23h" still won't fit, drop the index
  // rather than let the two numbers collide.
  const slotIndex = (() => {
    if (opts.slotNumber == null) return "";
    const text = `#${opts.slotNumber}`;
    const x = 49;
    const gap = 8;
    const ageLeft = S - 12 - estTextWidth(age, ageS.size);
    let size = 14;
    while (size > 9 && x + estTextWidth(text, size) > ageLeft - gap) size--;
    if (x + estTextWidth(text, size) > ageLeft - gap) return ""; // no room left
    return `<text x="${x}" y="32" font-size="${size}" font-weight="800" fill="#7b86c4" letter-spacing="0.3">${text}</text>`;
  })();

  // Status line (bottom): what the pane is doing, in triage order. A working
  // pane gone silent (probably hung) reads as stalled; otherwise "working"
  // (busy again) wins, since a failed/blocked notification lingers in cmux after
  // you respond. cmux's live "Needs" ranks below an explicit permission/failure.
  const status =
    STATUS_STYLES[
      item.stalled
        ? "stalled"
        : item.activity === "working"
          ? "working"
          : item.reason === "failed"
            ? "failed"
            : item.reason === "blocked"
              ? "blocked"
              : item.needsInput
                ? "needs"
                : "waiting"
    ];

  // Urgent states own the border in their own color; anything else falls back to
  // the workspace's own cmux color at a plain 4px.
  const borderColor = status.borderW ? status.color : (item.color ?? null);
  const borderW = status.borderW || (item.color ? 4 : 0);
  const border = borderW
    ? `<rect x="${borderW / 2}" y="${borderW / 2}" width="${S - borderW}" height="${S - borderW}" rx="16" fill="none" stroke="${borderColor}" stroke-width="${borderW}"/>`
    : "";

  // Title is the hero: fit the full text between the top chrome and the status
  // line — shrink + wrap (at separators) rather than truncate.
  const boxTop = 50;
  const boxBottom = 116;
  const fit = fitText(item.title || item.repo || "?", S - 24, boxBottom - boxTop, 14, 30);
  const lineH = fit.fontSize * 1.14;
  const totalH = fit.lines.length * lineH;
  const startY = boxTop + Math.max(0, (boxBottom - boxTop - totalH) / 2) + fit.fontSize * 0.82;
  const title = fit.lines
    .map(
      (l, i) =>
        `<text x="12" y="${(startY + i * lineH).toFixed(1)}" font-size="${fit.fontSize}" font-weight="800" fill="${a.fg}">${escapeXml(l)}</text>`,
    )
    .join("");

  // Source badge bottom-right: the real Orca mark / a cmux monogram, tinted by
  // source (blue=orca, green=cmux) and sized up so a key's origin reads at a
  // glance on the physical device when both sources share the board.
  const badge = sourceGlyphSvg(item.source, S - 36, S - 32, 26, sourceTint(item.source));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${a.bg[0]}"/>
      <stop offset="1" stop-color="${a.bg[1]}"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" rx="18" fill="url(#bg)"/>
  ${border}
  <g font-family="-apple-system, Helvetica, Arial, sans-serif">
    ${slotIndex}
    ${
      opts.viewBadge
        ? `<g><rect x="${S / 2 - 23}" y="8" width="46" height="17" rx="8" fill="#1f6feb"/><text x="${S / 2}" y="20" font-size="11" font-weight="800" text-anchor="middle" fill="#fff" letter-spacing="0.5">${escapeXml(opts.viewBadge)}</text></g>`
        : ""
    }
    <rect x="13" y="11" width="30" height="30" rx="8" fill="${a.accent}"/>
    ${
      providerIconSvg(item.agent, 17, 15, 22, "#10100f") ||
      `<text x="28" y="33" font-size="21" font-weight="700" text-anchor="middle" fill="#10100f">${escapeXml(a.glyph)}</text>`
    }
    <text x="${S - 12}" y="34" font-size="${ageS.size}" font-weight="800" text-anchor="end" fill="${ageS.color}">${escapeXml(age)}</text>
    ${title}
    <text x="12" y="${S - 11}" font-size="15" font-weight="800" fill="${status.color}" letter-spacing="0.5">${escapeXml(status.text)}</text>
    ${badge}
  </g>
</svg>`;
}

/** Shared chrome for the chrome-only tiles: ground, inset border, text group. */
function tile(stroke: string, strokeW: number, inner: string): string {
  const S = KEY_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="18" fill="#0d0e10"/>
  <rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="16" fill="none" stroke="${stroke}" stroke-width="${strokeW}"/>
  <g font-family="-apple-system, Helvetica, Arial, sans-serif" text-anchor="middle">${inner}</g>
</svg>`;
}

/**
 * Render the "all clear" tile shown on slot 0 when a view has no items (e.g.
 * the Decisions view with no decisions pending) — a calm, deliberate at-rest
 * state so an empty board doesn't read like a glitch of blank dots.
 */
export function renderAllClear(label: string): string {
  const S = KEY_SIZE;
  return tile("#1f3a2e", 2, `<text x="${S / 2}" y="${S / 2 - 2}" font-size="44" fill="#3fae7a">✓</text>
    <text x="${S / 2}" y="${S / 2 + 34}" font-size="15" font-weight="700" fill="#5b6b62">${escapeXml(label)}</text>`);
}

/**
 * Render the overflow tile shown on the last key when the queue has more items
 * than fit: a "+N more" count tinted by the most-severe hidden item's color, so
 * the board never silently lies about how much is hidden below the fold.
 */
export function renderOverflow(hiddenCount: number, accent: string): string {
  const S = KEY_SIZE;
  return tile(accent, 4, `<text x="${S / 2}" y="${S / 2 + 4}" font-size="40" font-weight="800" fill="${accent}">+${hiddenCount}</text>
    <text x="${S / 2}" y="${S / 2 + 36}" font-size="15" font-weight="700" fill="#7d8794">more</text>`);
}

/**
 * Render the pager's "back to top" face, shown in place of "+N more" on the
 * last page — tap to return to the top of the queue.
 */
export function renderPagerHome(): string {
  const S = KEY_SIZE;
  return tile("#3a3f48", 3, `<text x="${S / 2}" y="${S / 2 + 2}" font-size="40" font-weight="800" fill="#9aa0aa">↑</text>
    <text x="${S / 2}" y="${S / 2 + 36}" font-size="15" font-weight="700" fill="#9aa0aa">top</text>`);
}

/**
 * Render an empty slot: a muted, blank tile so unused keys read as "nothing
 * here" rather than stale data.
 */
export function renderEmptyKey(slotNumber: number): string {
  const S = KEY_SIZE;
  return tile("#1c1e22", 2, `<circle cx="${S / 2}" cy="${S / 2}" r="5" fill="#22252b"/>
  <text x="${S - 12}" y="138" font-size="14" text-anchor="end" fill="#2a2d33">${slotNumber}</text>`);
}

/**
 * Render a single muted "<label> unavailable" tile for slot 1 when every active
 * feed is down, so the keys communicate the outage instead of going dark.
 */
export function renderSourceOffline(label: string): string {
  const S = KEY_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="18" fill="#1a1416"/>
  <rect x="4" y="4" width="${S - 8}" height="${S - 8}" rx="15" fill="none" stroke="#7d3b3b" stroke-width="3"/>
  <text x="${S / 2}" y="64" font-size="40" text-anchor="middle" fill="#c66">⚠</text>
  <text x="${S / 2}" y="98" font-size="20" font-weight="700" text-anchor="middle" fill="#e6b3b3" font-family="-apple-system, Helvetica, Arial, sans-serif">${escapeXml(label)}</text>
  <text x="${S / 2}" y="120" font-size="16" text-anchor="middle" fill="#b88" font-family="-apple-system, Helvetica, Arial, sans-serif">offline</text>
</svg>`;
}
