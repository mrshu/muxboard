import { test } from "node:test";
import assert from "node:assert/strict";
import { renderKey, renderEmptyKey, renderOverflow, renderSourceOffline } from "../src/core/render/keyRender.js";
import {
  renderLcdSegments,
  routeStatus,
  reservePercent,
  elapsedPercent,
} from "../src/core/render/lcdRender.js";
import type { UsageWindow } from "../src/core/types.js";
import { formatAge, formatCountdown, formatUsd, shortName } from "../src/core/render/format.js";
import { normalizeUsageResponse } from "../src/core/codexbar/normalize.js";
import { normalizeNotifications } from "../src/core/cmux/normalize.js";
import { loadFixture, NOW_MS } from "./helpers.js";

test("format helpers are compact and deterministic", () => {
  assert.equal(formatAge("2026-06-20T12:08:00Z", NOW_MS), "2m");
  assert.equal(formatAge("2026-06-20T11:10:00Z", NOW_MS), "1h");
  assert.equal(formatCountdown("2026-06-20T14:10:00Z", NOW_MS), "2h");
  assert.equal(formatCountdown(undefined, NOW_MS), "—");
  assert.equal(formatUsd(4.2), "$4.20");
  assert.equal(formatUsd(undefined), "—");
  assert.equal(shortName("~/w/d/r/codex-playground", 13), "codex-playgr…");
});

test("reservePercent: reserve, on-par, deficit, and unbounded windows", () => {
  // A 300-minute window with 150 minutes left → exactly 50% elapsed.
  const at = (minLeft: number) => new Date(NOW_MS + minLeft * 60_000).toISOString();
  const win = (used: number, minLeft: number): UsageWindow => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    resetsAt: at(minLeft),
    windowMinutes: 300,
  });
  assert.equal(elapsedPercent(win(0, 150), NOW_MS), 50);
  assert.equal(reservePercent(win(20, 150), NOW_MS), 30); // used 20 < elapsed 50 → +30 reserve
  assert.equal(reservePercent(win(48, 150), NOW_MS), 2); // within dead-band → ~on par
  assert.equal(reservePercent(win(70, 150), NOW_MS), -20); // used 70 > elapsed 50 → deficit
  // No reset time / window length (e.g. an "Unlimited" window) → undefined.
  assert.equal(elapsedPercent({ usedPercent: 10, remainingPercent: 90 }, NOW_MS), undefined);
  assert.equal(reservePercent({ usedPercent: 10, remainingPercent: 90 }, NOW_MS), undefined);
});

test("renderKey embeds agent glyph, reason, repo, and age", () => {
  const items = normalizeNotifications(loadFixture("cmux-notifications.json"));
  const codex = items.find((i) => i.agent === "codex");
  assert.ok(codex);
  const svg = renderKey(codex!, { nowMs: NOW_MS, slotNumber: 1 });
  assert.match(svg, /<svg/);
  assert.match(svg, /<g transform="translate[^"]+scale/); // codex brand icon, inlined
  assert.match(svg, /FAILED/); // reason chip
  assert.match(svg, /codex/); // title (auto-fit, may wrap)
  assert.match(svg, /stroke-width="10"/); // failed -> strongest border (rank-tracking ramp)
});

test("omp gets its own magenta theme, not the grey unknown fallback", async () => {
  const { agentTheme } = await import("../src/core/render/palette.js");
  const theme = agentTheme("omp");
  assert.equal(theme.label, "OMP");
  assert.equal(theme.accent, "#e070bd");
  assert.equal(theme.glyph, "Ω"); // text fallback if the icon ever goes missing
});

test("renderKey draws the vendored oh-my-pi icon for omp items", () => {
  const base = { id: "o", agent: "omp" as const, workspaceId: "w", title: "omp", reason: "waiting" as const, activity: "waiting" as const, body: "", message: "", createdAt: "2026-06-20T12:00:00Z" };
  const svg = renderKey(base, { nowMs: NOW_MS, slotNumber: 1 });
  assert.match(svg, /<g transform="translate[^"]+scale/); // vendored icon, inlined
  assert.doesNotMatch(svg, />Ω</); // icon wins over the text-glyph fallback
});

test("renderKey marks a stalled pane distinctly from plain working", () => {
  const base = { id: "x", agent: "claude" as const, workspaceId: "w", title: "t", reason: "waiting" as const, activity: "working" as const, body: "", message: "", createdAt: "2026-06-20T12:00:00Z" };
  assert.match(renderKey(base, { nowMs: Date.parse("2026-06-20T12:01:00Z") }), /working/);
  assert.match(renderKey({ ...base, stalled: true }, { nowMs: Date.parse("2026-06-20T12:01:00Z") }), /STALLED/);
});

test("renderOverflow shows the hidden count", () => {
  const svg = renderOverflow(5, "#ff4d4f");
  assert.match(svg, /\+5/);
  assert.match(svg, /more/);
});

test("renderKey shows the slot index and an un-capped age-warmth size", () => {
  const base = {
    id: "x",
    agent: "claude" as const,
    workspaceId: "w",
    title: "RCJ Scoreboard",
    reason: "waiting" as const,
    activity: "waiting" as const,
    body: "",
    message: "",
    createdAt: "2026-06-20T12:00:00Z",
  };
  // >2h old → ageStyle size 30, which the old Math.min(..,24) clamp made impossible.
  const old = renderKey(base, { nowMs: Date.parse("2026-06-20T15:00:00Z"), slotNumber: 7 });
  assert.match(old, /font-size="30"/); // the hottest age size now actually renders
  assert.match(old, />#7</); // the 1-based slot index is drawn (hash-prefixed) on a live key
});

test("the slot index never overlaps the age, shrinking or dropping as needed", () => {
  const base = {
    id: "x",
    agent: "claude" as const,
    workspaceId: "w",
    title: "RCJ Scoreboard",
    reason: "waiting" as const,
    activity: "waiting" as const,
    body: "",
    message: "",
    createdAt: "2026-06-19T12:00:00Z", // 23h before nowMs below → hot age, size 30
  };
  const nowMs = Date.parse("2026-06-20T11:00:00Z");
  const estW = (s: string, fs: number) => s.length * fs * 0.6; // mirrors estTextWidth
  // For a given index, the rendered index (if any) must clear the age's left edge.
  const assertClears = (slotNumber: number) => {
    const svg = renderKey(base, { nowMs, slotNumber });
    const ageM = svg.match(/x="132" y="34" font-size="(\d+)"[^>]*text-anchor="end"[^>]*>([^<]+)</);
    assert.ok(ageM, "age text should render");
    const ageLeft = 132 - estW(ageM![2], Number(ageM![1]));
    const idxM = svg.match(/<text x="(\d+)" y="32" font-size="(\d+)"[^>]*fill="#7b86c4"[^>]*>(#\d+)</);
    if (idxM) {
      const idxRight = Number(idxM[1]) + estW(idxM![3], Number(idxM![2]));
      assert.ok(idxRight <= ageLeft, `#${slotNumber}: index right ${idxRight} must clear age left ${ageLeft}`);
    }
  };
  assert.match(renderKey(base, { nowMs, slotNumber: 42 }), />#42</); // mid index shrinks, still shown
  for (const n of [1, 42, 128, 9999]) assertClears(n);
});

test("a working pane overrides a lingering permission/failed notification", () => {
  const base = {
    id: "x",
    agent: "claude" as const,
    workspaceId: "w",
    title: "RCJ Scoreboard",
    body: "",
    message: "",
    createdAt: "2026-06-20T12:08:00Z",
  };
  // Still blocked + waiting → shows PERMISSION.
  const waiting = renderKey({ ...base, reason: "blocked", activity: "waiting" }, { nowMs: NOW_MS, slotNumber: 1 });
  assert.match(waiting, /PERMISSION/);
  // Responded → agent resumed (working) → no PERMISSION, shows working.
  const work = renderKey({ ...base, reason: "blocked", activity: "working" }, { nowMs: NOW_MS, slotNumber: 1 });
  assert.doesNotMatch(work, /PERMISSION/);
  assert.match(work, /working/);
});

test("a needs-input pane is shown prominently, distinct from plain waiting", () => {
  const base = {
    id: "x",
    agent: "claude" as const,
    workspaceId: "w",
    title: "RCJ Scoreboard",
    reason: "waiting" as const,
    activity: "waiting" as const,
    body: "",
    message: "",
    createdAt: "2026-06-20T12:08:00Z",
  };
  const needs = renderKey({ ...base, needsInput: true }, { nowMs: NOW_MS, slotNumber: 1 });
  assert.match(needs, /NEEDS YOU/);
  assert.doesNotMatch(needs, />waiting</); // not the plain grey label
  // A working pane ignores a stale needs flag.
  const work = renderKey({ ...base, needsInput: true, activity: "working" }, { nowMs: NOW_MS, slotNumber: 1 });
  assert.doesNotMatch(work, /NEEDS YOU/);
});

test("renderEmptyKey and renderSourceOffline produce valid muted SVGs", () => {
  const empty = renderEmptyKey(8);
  assert.match(empty, /<svg/);
  assert.match(empty, />8<\/text>/);
  const offline = renderSourceOffline("cmux");
  assert.match(offline, /offline/);
  assert.match(offline, /cmux/);
});

test("renderLcdSegments shows one provider per segment, all at a glance", () => {
  const codex = normalizeUsageResponse(loadFixture("codexbar-usage-codex.json"), "codex");
  codex.costTodayUsd = 4.2;
  codex.tokensToday = 1_200_000;
  const claude = normalizeUsageResponse(loadFixture("codexbar-usage-claude.json"), "claude");
  const kimi = normalizeUsageResponse(loadFixture("codexbar-usage-kimi.json"), "kimi");

  const [s0, s1, s2, s3] = renderLcdSegments([codex, claude, kimi, undefined], {
    nowMs: NOW_MS,
    stale: false,
    numberMode: "remaining",
  });
  // codex: brand-color name; the default row number is absolute remaining%
  assert.match(s0, /CODEX/);
  assert.match(s0, /#49A3B0/i); // codex brand color from CodexBar
  assert.match(s0, /99%/); // session remaining
  assert.match(s0, /75%/); // weekly remaining
  // the pace marker (ghost) shows even in remaining mode: weekly is in reserve
  assert.match(s0, /fill-opacity="0.3"/);
  // footer: today's spend + tokens
  assert.match(s0, /\$4\.20/);
  assert.match(s0, /1\.2M tok/);
  // claude visible in its own segment
  assert.match(s1, /CLAUDE/);
  assert.match(s1, /97%/);
  // kimi (error) shows offline
  assert.match(s2, /KIMI/);
  assert.match(s2, /offline/);
  // empty slot is muted
  assert.match(s3, /—/);
});

test("the rightmost dial toggles the quota number to the pace delta", () => {
  const codex = normalizeUsageResponse(loadFixture("codexbar-usage-codex.json"), "codex");
  const [s0] = renderLcdSegments([codex], { nowMs: NOW_MS, stale: false, numberMode: "pace" });
  // session ~on-par ("+0%"), weekly ~12% under the clock ("+12%") in reserve green
  assert.match(s0, /\+0%/);
  assert.match(s0, /\+12%/);
  assert.match(s0, /#46e07a/i);
  // remaining% is not shown in pace mode
  assert.doesNotMatch(s0, /75%/);
});

test("provider segment marks stale data", () => {
  const codex = normalizeUsageResponse(loadFixture("codexbar-usage-codex.json"), "codex");
  const [seg] = renderLcdSegments([codex], { nowMs: NOW_MS, stale: true, numberMode: "remaining" });
  assert.match(seg, /stale/);
  assert.equal(routeStatus(codex, true), "STALE");
});
