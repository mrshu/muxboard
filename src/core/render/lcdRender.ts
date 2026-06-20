import type { ProviderUsage, UsageWindow } from "../types.js";
import { providerColor, usageColor } from "./palette.js";
import { escapeXml, formatCountdown, formatEur, formatPercent } from "./format.js";

/** Touch-strip segment size: one of the four 200×100 LCD regions. */
export const SEG_W = 200;
export const SEG_H = 100;

export interface LcdRenderContext {
  nowMs: number;
  /** True when CodexBar data is older than 2× the poll interval. */
  stale: boolean;
}

/** Route/health label derived from the worst window of a provider. */
export type RouteStatus = "OK" | "LOW" | "CAP" | "STALE" | "OFF";

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

/** One quota row (session or weekly): label, gauge, % remaining, and reset. */
function quotaRow(y: number, label: string, win: UsageWindow | undefined, nowMs: number): string {
  if (!win) {
    return `<text x="12" y="${y}" font-size="13" fill="#5a606a">${label}  —</text>`;
  }
  const used = win.usedPercent;
  const reset = formatCountdown(win.resetsAt, nowMs);
  return `<text x="12" y="${y}" font-size="13" font-weight="700" fill="#aeb4be">${label}</text>
    ${bar(28, y - 9, 78, 9, used)}
    <text x="148" y="${y}" font-size="13" font-weight="700" text-anchor="end" fill="${usageColor(used)}">${formatPercent(win.remainingPercent)}</text>
    <text x="${SEG_W - 10}" y="${y}" font-size="11" text-anchor="end" fill="#8a909a">${escapeXml(reset)}</text>`;
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

  if (!usage.ok) {
    return segFrame(
      `<text x="12" y="26" font-size="18" font-weight="800" fill="${nameColor}" letter-spacing="1">${escapeXml(name)}</text>
       <text x="12" y="58" font-size="17" font-weight="700" fill="#ff7a7a">offline</text>
       ${usage.error ? `<text x="12" y="80" font-size="11" fill="#8a909a">${escapeXml(shortError(usage.error))}</text>` : ""}`,
      "#7d3b3b",
    );
  }

  const cost = usage.costTodayEur !== undefined ? formatEur(usage.costTodayEur) : "";
  const footer = [cost ? `${cost} today` : "", ctx.stale ? "stale" : ""].filter(Boolean).join(" · ");
  return segFrame(
    `<text x="12" y="24" font-size="18" font-weight="800" fill="${nameColor}" letter-spacing="1">${escapeXml(name)}</text>
     <text x="${SEG_W - 10}" y="23" font-size="10" text-anchor="end" fill="#5a606a">reset →</text>
     ${quotaRow(50, "S", usage.session, ctx.nowMs)}
     ${quotaRow(72, "W", usage.weekly, ctx.nowMs)}
     ${footer ? `<text x="12" y="92" font-size="12" fill="#8a909a">${escapeXml(footer)}</text>` : ""}`,
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
