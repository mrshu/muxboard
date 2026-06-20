import type { AttentionItem } from "../types.js";
import { agentTheme } from "./palette.js";
import { escapeXml, fitText, formatAge } from "./format.js";
import { providerIconSvg } from "./providerIcons.js";

/** Key canvas size. Stream Deck keys are 72pt; we render @2x for crispness. */
export const KEY_SIZE = 144;

export interface KeyRenderOptions {
  /** Epoch ms used to compute age. */
  nowMs: number;
  /** 1-based slot number shown as a faint corner index. */
  slotNumber: number;
}

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
  const ageSeconds = Math.max(0, Math.floor((opts.nowMs - Date.parse(item.createdAt)) / 1000));
  const age = formatAge(item.createdAt, opts.nowMs);
  const ageS = ageStyle(ageSeconds);
  const S = KEY_SIZE;

  const isFailed = item.reason === "failed";
  const isBlocked = item.reason === "blocked";
  const exc = isFailed || isBlocked;
  const excColor = isFailed ? "#ff4d4f" : "#ffb02e";
  const borderW = isFailed ? 8 : isBlocked ? 5 : 0;
  const border = borderW
    ? `<rect x="${borderW / 2}" y="${borderW / 2}" width="${S - borderW}" height="${S - borderW}" rx="16" fill="none" stroke="${excColor}" stroke-width="${borderW}"/>`
    : "";

  // Title is the hero: fit the full text into the box below the top chrome and
  // above the optional exception chip — shrink + wrap rather than truncate.
  const boxTop = 50;
  const boxBottom = exc ? 116 : 136;
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

  const chip = exc
    ? `<text x="12" y="${S - 12}" font-size="15" font-weight="800" fill="${excColor}" letter-spacing="1">${isFailed ? "✕ FAILED" : "PERMISSION"}</text>`
    : "";

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
    <rect x="13" y="11" width="30" height="30" rx="8" fill="${a.accent}"/>
    ${
      providerIconSvg(item.agent, 17, 15, 22, "#10100f") ||
      `<text x="28" y="33" font-size="21" font-weight="700" text-anchor="middle" fill="#10100f">${escapeXml(a.glyph)}</text>`
    }
    <text x="${S - 12}" y="34" font-size="${Math.min(ageS.size, 24)}" font-weight="800" text-anchor="end" fill="${ageS.color}">${escapeXml(age)}</text>
    ${title}
    ${chip}
  </g>
</svg>`;
}

/**
 * Render an empty slot: a muted, blank tile so unused keys read as "nothing
 * here" rather than stale data.
 */
export function renderEmptyKey(slotNumber: number): string {
  const S = KEY_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="18" fill="#0d0e10"/>
  <rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="16" fill="none" stroke="#1c1e22" stroke-width="2"/>
  <circle cx="${S / 2}" cy="${S / 2}" r="5" fill="#22252b"/>
  <text x="${S - 12}" y="138" font-size="14" text-anchor="end" fill="#2a2d33" font-family="-apple-system, Helvetica, Arial, sans-serif">${slotNumber}</text>
</svg>`;
}

/**
 * Render a single muted "cmux unavailable" tile for slot 1 when the cmux feed
 * is down, so the keys communicate the outage instead of going dark silently.
 */
export function renderCmuxOffline(): string {
  const S = KEY_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="18" fill="#1a1416"/>
  <rect x="4" y="4" width="${S - 8}" height="${S - 8}" rx="15" fill="none" stroke="#7d3b3b" stroke-width="3"/>
  <text x="${S / 2}" y="64" font-size="40" text-anchor="middle" fill="#c66">⚠</text>
  <text x="${S / 2}" y="98" font-size="20" font-weight="700" text-anchor="middle" fill="#e6b3b3" font-family="-apple-system, Helvetica, Arial, sans-serif">cmux</text>
  <text x="${S / 2}" y="120" font-size="16" text-anchor="middle" fill="#b88" font-family="-apple-system, Helvetica, Arial, sans-serif">offline</text>
</svg>`;
}
