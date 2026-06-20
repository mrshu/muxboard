import { test } from "node:test";
import assert from "node:assert/strict";
import { renderKey, renderEmptyKey, renderCmuxOffline } from "../src/core/render/keyRender.js";
import {
  renderLcdSegments,
  routeStatus,
} from "../src/core/render/lcdRender.js";
import { formatAge, formatCountdown, formatEur, shortName } from "../src/core/render/format.js";
import { normalizeUsageResponse } from "../src/core/codexbar/normalize.js";
import { normalizeNotifications } from "../src/core/cmux/normalize.js";
import { loadFixture, NOW_MS } from "./helpers.js";

test("format helpers are compact and deterministic", () => {
  assert.equal(formatAge("2026-06-20T12:08:00Z", NOW_MS), "2m");
  assert.equal(formatAge("2026-06-20T11:10:00Z", NOW_MS), "1h");
  assert.equal(formatCountdown("2026-06-20T14:10:00Z", NOW_MS), "2h");
  assert.equal(formatCountdown(undefined, NOW_MS), "—");
  assert.equal(formatEur(4.2), "€4.20");
  assert.equal(formatEur(undefined), "—");
  assert.equal(shortName("~/w/d/r/codex-playground", 13), "codex-playgr…");
});

test("renderKey embeds agent glyph, reason, repo, and age", () => {
  const items = normalizeNotifications(loadFixture("cmux-notifications.json"));
  const codex = items.find((i) => i.agent === "codex");
  assert.ok(codex);
  const svg = renderKey(codex!, { nowMs: NOW_MS, slotNumber: 1 });
  assert.match(svg, /<svg/);
  assert.match(svg, />X<\/text>/); // codex glyph
  assert.match(svg, /FAILED/); // reason
  assert.match(svg, /codex-playg/); // repo (path-stripped + shortened)
  assert.match(svg, /stroke-width="8"/); // failed -> strongest border
});

test("renderEmptyKey and renderCmuxOffline produce valid muted SVGs", () => {
  const empty = renderEmptyKey(8);
  assert.match(empty, /<svg/);
  assert.match(empty, />8<\/text>/);
  const offline = renderCmuxOffline();
  assert.match(offline, /offline/);
});

test("renderLcdSegments shows session, weekly, route, and spend", () => {
  const usage = normalizeUsageResponse(loadFixture("codexbar-usage-codex.json"), "codex");
  usage.costTodayEur = 4.2;
  const [session, weekly, route, cost] = renderLcdSegments(usage, { nowMs: NOW_MS, stale: false });
  assert.match(session, /SESSION/);
  assert.match(session, /99%/); // 100 - usedPercent
  assert.match(weekly, /WEEKLY/);
  assert.match(weekly, /75%/);
  assert.match(route, /STATUS/);
  assert.match(route, /OK/);
  assert.match(cost, /€4\.20/);
});

test("route/cost segments reflect offline + stale states", () => {
  const offlineSegs = renderLcdSegments(undefined, { nowMs: NOW_MS, stale: false });
  assert.match(offlineSegs[2], /OFF/);
  assert.match(offlineSegs[3], /CodexBar off/);

  const usage = normalizeUsageResponse(loadFixture("codexbar-usage-codex.json"), "codex");
  const staleSegs = renderLcdSegments(usage, { nowMs: NOW_MS, stale: true });
  assert.match(staleSegs[0], /STALE/);
  assert.equal(routeStatus(usage, true), "STALE");
});
