import type { AttentionItem } from "../types.js";
import { agentTheme, reasonTheme } from "./palette.js";
import { escapeXml, formatAge, shortName } from "./format.js";

/** Key canvas size. Stream Deck keys are 72pt; we render @2x for crispness. */
export const KEY_SIZE = 144;

export interface KeyRenderOptions {
  /** Epoch ms used to compute age. */
  nowMs: number;
  /** 1-based slot number shown as a faint corner index. */
  slotNumber: number;
}

/**
 * Render an attention item to an SVG string for a Stream Deck key.
 *
 * Layout (144×144):
 *   - agent-tinted gradient background
 *   - top: agent glyph chip (left) + age (right)
 *   - middle: reason band (color scaled by urgency)
 *   - bottom: short repo/workspace name + a small body hint
 */
export function renderKey(item: AttentionItem, opts: KeyRenderOptions): string {
  const a = agentTheme(item.agent);
  const r = reasonTheme(item.reason);
  const age = formatAge(item.createdAt, opts.nowMs);
  const repo = escapeXml(shortName(item.repo ?? item.title, 13));
  const hint = escapeXml(shortName(stripBody(item.body), 16));
  const S = KEY_SIZE;

  // Failed gets a full colored border; blocked/waiting a thinner one.
  const borderW = r.urgency >= 3 ? 8 : r.urgency >= 2 ? 5 : 0;
  const border =
    borderW > 0
      ? `<rect x="${borderW / 2}" y="${borderW / 2}" width="${S - borderW}" height="${S - borderW}" rx="16" fill="none" stroke="${r.color}" stroke-width="${borderW}"/>`
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
    <rect x="14" y="14" width="36" height="36" rx="9" fill="${a.accent}"/>
    <text x="32" y="41" font-size="26" font-weight="700" text-anchor="middle" fill="#10100f">${escapeXml(a.glyph)}</text>
    <text x="${S - 14}" y="38" font-size="22" font-weight="600" text-anchor="end" fill="${a.fg}">${escapeXml(age)}</text>
    <rect x="14" y="62" width="${S - 28}" height="34" rx="8" fill="${r.color}" opacity="${r.urgency >= 1 ? 1 : 0.5}"/>
    <text x="${S / 2}" y="85" font-size="22" font-weight="800" text-anchor="middle" fill="#10100f" letter-spacing="1">${escapeXml(r.label)}</text>
    <text x="14" y="120" font-size="20" font-weight="700" fill="${a.fg}">${repo}</text>
    <text x="14" y="138" font-size="15" fill="${a.fg}" opacity="0.7">${hint}</text>
    <text x="${S - 12}" y="138" font-size="14" text-anchor="end" fill="${a.fg}" opacity="0.4">${opts.slotNumber}</text>
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

/** Collapse whitespace/newlines in a notification body to a single line. */
function stripBody(body: string): string {
  return body.replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
}
