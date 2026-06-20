import type { ProviderUsage, UsageWindow } from "../types.js";
import { usageColor } from "./palette.js";
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

/**
 * Segment 1 / 2: a single usage window (session or weekly) with a percent,
 * a gauge, and a reset countdown.
 */
export function renderUsageSegment(
  heading: string,
  win: UsageWindow | undefined,
  ctx: LcdRenderContext,
): string {
  if (!win) {
    return segFrame(
      `<text x="14" y="30" font-size="17" font-weight="700" fill="#9aa0aa">${escapeXml(heading)}</text>
       <text x="14" y="64" font-size="20" fill="#666c76">no data</text>`,
    );
  }
  const used = win.usedPercent;
  const remaining = formatPercent(win.remainingPercent);
  const reset = formatCountdown(win.resetsAt, ctx.nowMs);
  const staleTag = ctx.stale
    ? `<text x="${SEG_W - 12}" y="30" font-size="13" text-anchor="end" fill="#ffb02e">STALE</text>`
    : "";
  return segFrame(
    `<text x="14" y="30" font-size="17" font-weight="800" fill="#e6e8ec" letter-spacing="1">${escapeXml(heading)}</text>
     ${staleTag}
     <text x="14" y="62" font-size="30" font-weight="800" fill="${usageColor(used)}">${remaining}</text>
     <text x="${SEG_W - 12}" y="62" font-size="16" text-anchor="end" fill="#aeb4be">left</text>
     ${bar(14, 72, SEG_W - 28, 10, used)}
     <text x="14" y="96" font-size="13" fill="#aeb4be">reset ${escapeXml(reset)}</text>`,
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

const ROUTE_COLOR: Record<RouteStatus, string> = {
  OK: "#4ec9b0",
  LOW: "#ffd23f",
  CAP: "#ff4d4f",
  STALE: "#ffb02e",
  OFF: "#7d828c",
};

/** Segment 3: provider identity + status/health pill. */
export function renderRouteSegment(usage: ProviderUsage | undefined, stale: boolean): string {
  const status = routeStatus(usage, stale);
  const color = ROUTE_COLOR[status];
  const provider = (usage?.provider ?? "codexbar").toUpperCase();
  return segFrame(
    `<text x="14" y="30" font-size="17" font-weight="800" fill="#e6e8ec" letter-spacing="1">STATUS</text>
     <text x="${SEG_W - 12}" y="30" font-size="14" text-anchor="end" fill="#aeb4be">${escapeXml(shortProvider(provider))}</text>
     <rect x="14" y="44" width="${SEG_W - 28}" height="40" rx="8" fill="${color}" opacity="0.18"/>
     <text x="${SEG_W / 2}" y="72" font-size="28" font-weight="800" text-anchor="middle" fill="${color}" letter-spacing="2">${status}</text>`,
    color,
  );
}

/** Segment 4: today's spend, or a fallback (offline / stale / error). */
export function renderCostSegment(usage: ProviderUsage | undefined, ctx: LcdRenderContext): string {
  if (!usage || !usage.ok) {
    const msg = usage?.error ? shortError(usage.error) : "CodexBar off";
    return segFrame(
      `<text x="14" y="30" font-size="17" font-weight="800" fill="#e6e8ec" letter-spacing="1">SPEND</text>
       <text x="14" y="66" font-size="20" font-weight="700" fill="#ff7a7a">${escapeXml(msg)}</text>`,
      "#7d3b3b",
    );
  }
  const cost = formatEur(usage.costTodayEur);
  const staleLine = ctx.stale ? "data stale" : "today";
  return segFrame(
    `<text x="14" y="30" font-size="17" font-weight="800" fill="#e6e8ec" letter-spacing="1">SPEND</text>
     <text x="14" y="68" font-size="34" font-weight="800" fill="#e6e8ec">${escapeXml(cost)}</text>
     <text x="14" y="92" font-size="14" fill="#aeb4be">${escapeXml(staleLine)}</text>`,
    ctx.stale ? "#ffb02e" : "#222831",
  );
}

/**
 * Render all four segments for a provider in display order:
 * [session, weekly, route, cost].
 */
export function renderLcdSegments(usage: ProviderUsage | undefined, ctx: LcdRenderContext): [string, string, string, string] {
  return [
    renderUsageSegment("SESSION", usage?.session, ctx),
    renderUsageSegment("WEEKLY", usage?.weekly, ctx),
    renderRouteSegment(usage, ctx.stale),
    renderCostSegment(usage, ctx),
  ];
}

function shortProvider(p: string): string {
  return p.length > 8 ? p.slice(0, 8) : p;
}
function shortError(e: string): string {
  return e.length > 16 ? `${e.slice(0, 15)}…` : e;
}
