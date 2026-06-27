import type { LcdNumberMode, ProviderUsage, UsageWindow } from "../types.js";
import { providerColor, usageColor } from "./palette.js";
import { escapeXml, formatCountdown, formatTokens, formatUsd, formatPercent } from "./format.js";
import { providerIconSvg } from "./providerIcons.js";

/** Touch-strip segment size: one of the four 200×100 LCD regions. */
export const SEG_W = 200;
export const SEG_H = 100;

export interface LcdRenderContext {
  nowMs: number;
  /** True when CodexBar data is older than 2× the poll interval. */
  stale: boolean;
  /** Which number the quota rows show (toggled by the rightmost dial). */
  numberMode: LcdNumberMode;
}

/** Route/health label derived from the worst window of a provider. */
export type RouteStatus = "OK" | "LOW" | "CAP" | "STALE" | "OFF";

/** Coral cap drawn over the gauge when spending ahead of the clock (deficit). */
const DEFICIT_COLOR = "#ff6a5a";
/** Pace number: green when banking headroom, coral when overspending, muted
 * when on-par (within the dead-band). */
const RESERVE_TEXT = "#46e07a";
const DEFICIT_TEXT = "#ff6a5a";
const ONPAR_TEXT = "#8a909a";
/** |pace| below this many points is treated as on-par (no marker, no number). */
const PACE_DEADBAND = 3;

function segFrame(inner: string, accent = "#222831"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SEG_W}" height="${SEG_H}" viewBox="0 0 ${SEG_W} ${SEG_H}">
  <rect width="${SEG_W}" height="${SEG_H}" fill="#0b0c0e"/>
  <rect x="1" y="1" width="${SEG_W - 2}" height="${SEG_H - 2}" fill="none" stroke="${accent}" stroke-width="2"/>
  <g font-family="-apple-system, Helvetica, Arial, sans-serif">${inner}</g>
</svg>`;
}

function bar(x: number, y: number, w: number, h: number, usedPercent: number): string {
  const fillW = Math.round((Math.max(0, Math.min(100, usedPercent)) / 100) * w);
  const color = usageColor(usedPercent);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#1b1e24"/>
    <rect x="${x}" y="${y}" width="${fillW}" height="${h}" rx="${h / 2}" fill="${color}"/>`;
}

/**
 * Fraction of a window's time already elapsed (0..100), or undefined when the
 * reset time / window length is unknown (e.g. an "Unlimited" window). The window
 * started `windowMinutes` before it resets, so elapsed = length − time-to-reset.
 */
export function elapsedPercent(win: UsageWindow, nowMs: number): number | undefined {
  if (!win.resetsAt || !win.windowMinutes) return undefined;
  const reset = Date.parse(win.resetsAt);
  if (Number.isNaN(reset)) return undefined;
  const windowMs = win.windowMinutes * 60_000;
  const elapsedMs = windowMs - (reset - nowMs);
  return Math.max(0, Math.min(100, (elapsedMs / windowMs) * 100));
}

/**
 * Pacing vs. the clock, in percentage points: positive = in reserve (using
 * slower than time passes — banking headroom, actionable since we want
 * utilization high), negative = in deficit (will cap before reset). undefined
 * when the window has no time bounds.
 */
export function reservePercent(win: UsageWindow, nowMs: number): number | undefined {
  const elapsed = elapsedPercent(win, nowMs);
  if (elapsed === undefined) return undefined;
  return Math.round(elapsed - win.usedPercent);
}

/**
 * Pace marker on a gauge: a faded same-hue extension toward the on-pace point
 * when in reserve, or a coral cap past it when in deficit. Nothing within the
 * dead-band or when elapsed is unknown — so it stays calm and never slashes a
 * hard line through the bar.
 */
function paceOverlay(x: number, y: number, w: number, h: number, used: number, elapsed: number | undefined): string {
  if (elapsed === undefined) return "";
  const pace = used - elapsed; // + over the clock (deficit), − under it (reserve)
  if (Math.abs(pace) < PACE_DEADBAND) return "";
  const at = (p: number) => x + (Math.max(0, Math.min(100, p)) / 100) * w;
  const xUsed = at(used);
  const xPace = at(elapsed);
  if (pace < 0) {
    // reserve: ghost the unused headroom from here to the on-pace point.
    return `<rect x="${xUsed}" y="${y}" width="${Math.max(0, xPace - xUsed)}" height="${h}" rx="${h / 2}" fill="${usageColor(used)}" fill-opacity="0.3"/>`;
  }
  // deficit: coral over-cap from the on-pace point out to actual usage.
  return `<rect x="${xPace}" y="${y}" width="${Math.max(0, xUsed - xPace)}" height="${h}" rx="${h / 2}" fill="${DEFICIT_COLOR}" fill-opacity="0.92"/>`;
}

/**
 * The signed pace delta for a window: + green = reserve (headroom to spend),
 * − coral = deficit (over the clock), muted within the dead-band. Unbounded
 * "Unlimited" windows have no pace, so they fall back to remaining%.
 */
function paceNumber(win: UsageWindow, nowMs: number): { text: string; color: string } {
  const reserve = reservePercent(win, nowMs);
  if (reserve === undefined) {
    return { text: formatPercent(win.remainingPercent), color: usageColor(win.usedPercent) };
  }
  const sign = reserve >= 0 ? "+" : "−";
  const color =
    Math.abs(reserve) < PACE_DEADBAND ? ONPAR_TEXT : reserve > 0 ? RESERVE_TEXT : DEFICIT_TEXT;
  return { text: `${sign}${Math.abs(reserve)}%`, color };
}

/** The right-column number for a window, per the active mode. */
function rowNumber(win: UsageWindow, nowMs: number, mode: LcdNumberMode): { text: string; color: string } {
  if (mode === "pace") return paceNumber(win, nowMs);
  return { text: formatPercent(win.remainingPercent), color: usageColor(win.usedPercent) };
}

/**
 * One quota row (session or weekly): label, gauge + pace marker, the mode's
 * number (remaining% or pace delta), and reset. The pace marker is shown in
 * both modes — only the number changes.
 */
function quotaRow(
  y: number,
  label: string,
  win: UsageWindow | undefined,
  nowMs: number,
  mode: LcdNumberMode,
): string {
  if (!win) {
    return `<text x="12" y="${y}" font-size="13" fill="#5a606a">${label}  —</text>`;
  }
  const used = win.usedPercent;
  const elapsed = elapsedPercent(win, nowMs);
  const reset = formatCountdown(win.resetsAt, nowMs);
  const num = rowNumber(win, nowMs, mode);
  return `<text x="12" y="${y}" font-size="13" font-weight="700" fill="#aeb4be">${label}</text>
    ${bar(28, y - 9, 78, 9, used)}
    ${paceOverlay(28, y - 9, 78, 9, used, elapsed)}
    <text x="148" y="${y}" font-size="13" font-weight="700" text-anchor="end" fill="${num.color}">${num.text}</text>
    <text x="${SEG_W - 10}" y="${y}" font-size="11" text-anchor="end" fill="#8a909a">${escapeXml(reset)}</text>`;
}

/**
 * Footer line: today's spend + tokens — accounting metadata, dot-separated. No
 * pacing here (that lives on the gauge rows).
 */
function spendFooter(usage: ProviderUsage, stale: boolean): string {
  const parts: string[] = [];
  if (usage.costTodayUsd !== undefined) parts.push(formatUsd(usage.costTodayUsd));
  if (usage.tokensToday !== undefined) parts.push(`${formatTokens(usage.tokensToday)} tok`);
  if (stale) parts.push("stale");
  if (parts.length === 0) return "";
  return `<text x="12" y="92" font-size="12" fill="#8a909a">${escapeXml(parts.join(" · "))}</text>`;
}

/**
 * One LCD segment = one CodexBar provider, at a glance: name (colored by
 * health), today's spend, session + weekly gauges, and the session reset.
 */
export function renderProviderSegment(usage: ProviderUsage | undefined, ctx: LcdRenderContext): string {
  if (!usage) {
    return segFrame(`<text x="14" y="32" font-size="15" fill="#3a3d44">—</text>`, "#16181c");
  }
  const name = shortProvider((usage.provider || "?").toUpperCase());
  // Name uses CodexBar's brand color; gauges still convey health via usageColor.
  const nameColor = providerColor(usage.provider || "");
  // CodexBar's brand glyph, tinted to match, in the header.
  const icon = providerIconSvg(usage.provider || "", 12, 9, 18, nameColor);
  const nameX = icon ? 36 : 12;

  if (!usage.ok) {
    return segFrame(
      `${icon}<text x="${nameX}" y="26" font-size="18" font-weight="800" fill="${nameColor}" letter-spacing="1">${escapeXml(name)}</text>
       <text x="12" y="58" font-size="17" font-weight="700" fill="#ff7a7a">offline</text>
       ${usage.error ? `<text x="12" y="80" font-size="11" fill="#8a909a">${escapeXml(shortError(usage.error))}</text>` : ""}`,
      "#7d3b3b",
    );
  }

  return segFrame(
    `${icon}<text x="${nameX}" y="25" font-size="18" font-weight="800" fill="${nameColor}" letter-spacing="1">${escapeXml(name)}</text>
     <text x="${SEG_W - 10}" y="23" font-size="10" text-anchor="end" fill="#5a606a">reset →</text>
     ${quotaRow(50, "S", usage.session, ctx.nowMs, ctx.numberMode)}
     ${quotaRow(72, "W", usage.weekly, ctx.nowMs, ctx.numberMode)}
     ${spendFooter(usage, ctx.stale)}`,
    nameColor,
  );
}

/** Compute a route/health status from a provider's worst window. */
export function routeStatus(usage: ProviderUsage | undefined, stale: boolean): RouteStatus {
  if (!usage || !usage.ok) return "OFF";
  if (stale) return "STALE";
  const worstUsed = Math.max(usage.session?.usedPercent ?? 0, usage.weekly?.usedPercent ?? 0);
  if (worstUsed >= 95) return "CAP";
  if (worstUsed >= 80) return "LOW";
  return "OK";
}

/** Segment 3: provider identity + status/health pill. */
/**
 * Render the four touch-strip segments — one CodexBar provider per dial, so all
 * providers are visible at a glance. `usages` is taken in display order; missing
 * entries render as muted blanks.
 */
export function renderLcdSegments(
  usages: (ProviderUsage | undefined)[],
  ctx: LcdRenderContext,
): [string, string, string, string] {
  return [0, 1, 2, 3].map((i) => renderProviderSegment(usages[i], ctx)) as [
    string,
    string,
    string,
    string,
  ];
}

function shortProvider(p: string): string {
  return p.length > 8 ? p.slice(0, 8) : p;
}
function shortError(e: string): string {
  return e.length > 16 ? `${e.slice(0, 15)}…` : e;
}
