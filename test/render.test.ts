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

test("renderLcdSegments shows one provider per segment, all at a glance", () => {
  const codex = normalizeUsageResponse(loadFixture("codexbar-usage-codex.json"), "codex");
  codex.costTodayEur = 4.2;
  const claude = normalizeUsageResponse(loadFixture("codexbar-usage-claude.json"), "claude");
  const kimi = normalizeUsageResponse(loadFixture("codexbar-usage-kimi.json"), "kimi");

  const [s0, s1, s2, s3] = renderLcdSegments([codex, claude, kimi, undefined], {
    nowMs: NOW_MS,
    stale: false,
  });
  // codex: name + session 99% left + weekly 75% left + cost
  assert.match(s0, /CODEX/);
  assert.match(s0, /99%/);
  assert.match(s0, /75%/);
  assert.match(s0, /€4\.20/);
  // claude visible in its own segment
  assert.match(s1, /CLAUDE/);
  assert.match(s1, /97%/);
  // kimi (error) shows offline
  assert.match(s2, /KIMI/);
  assert.match(s2, /offline/);
  // empty slot is muted
  assert.match(s3, /—/);
});

test("provider segment marks stale data", () => {
  const codex = normalizeUsageResponse(loadFixture("codexbar-usage-codex.json"), "codex");
  const [seg] = renderLcdSegments([codex], { nowMs: NOW_MS, stale: true });
  assert.match(seg, /stale/);
  assert.equal(routeStatus(codex, true), "STALE");
});
