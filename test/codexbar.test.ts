import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCostToday,
  extractTokensToday,
  normalizeUsageResponse,
} from "../src/core/codexbar/normalize.js";
import { CodexbarClient } from "../src/core/codexbar/client.js";
import { loadFixture } from "./helpers.js";

test("normalizes the codex top-level window shape", () => {
  const raw = loadFixture("codexbar-usage-codex.json");
  const u = normalizeUsageResponse(raw, "codex");
  assert.equal(u.ok, true);
  assert.equal(u.provider, "codex");
  assert.equal(u.account, "openai@example.com");
  assert.equal(u.session?.usedPercent, 1);
  assert.equal(u.session?.remainingPercent, 99);
  assert.equal(u.weekly?.usedPercent, 25);
  assert.equal(u.weekly?.windowMinutes, 10080);
});

test("normalizes the claude nested-usage window shape", () => {
  const raw = loadFixture("codexbar-usage-claude.json");
  const u = normalizeUsageResponse(raw, "claude");
  assert.equal(u.ok, true);
  assert.equal(u.session?.usedPercent, 3);
  assert.equal(u.session?.remainingPercent, 97);
  assert.equal(u.weekly?.usedPercent, 0);
  assert.equal(u.account, "anthropic@example.com");
});

test("surfaces provider errors as unavailable", () => {
  const raw = loadFixture("codexbar-usage-kimi.json");
  const u = normalizeUsageResponse(raw, "kimi");
  assert.equal(u.ok, false);
  assert.match(u.error ?? "", /invalid or expired/);
});

test("empty response is unavailable, not a crash", () => {
  assert.equal(normalizeUsageResponse([], "codex").ok, false);
  assert.equal(normalizeUsageResponse(null, "codex").ok, false);
});

test("extractCostToday picks the most recent day", () => {
  const raw = loadFixture("codexbar-cost-codex.json");
  assert.equal(extractCostToday(raw), 4.2);
  assert.equal(extractCostToday([]), undefined);
});

test("extractTokensToday is the newest day's token count", () => {
  const raw = loadFixture("codexbar-cost-codex.json");
  assert.equal(extractTokensToday(raw), 500); // most recent day (2026-06-20)
  assert.equal(extractTokensToday([]), undefined);
});

test("CodexbarClient.getUsage merges usage + cost via injected fetcher", async () => {
  const usage = loadFixture("codexbar-usage-codex.json");
  const cost = loadFixture("codexbar-cost-codex.json");
  const client = new CodexbarClient({
    fetchJson: async (url) => (url.includes("/usage") ? usage : cost),
  });
  const u = await client.getUsage("codex");
  assert.equal(u.ok, true);
  assert.equal(u.costTodayUsd, 4.2);
});

test("getAllUsage discovers providers from /usage (no hardcoded list)", async () => {
  const codex = (loadFixture("codexbar-usage-codex.json") as unknown[])[0];
  const claude = (loadFixture("codexbar-usage-claude.json") as unknown[])[0];
  const minimax = (loadFixture("codexbar-usage-minimax.json") as unknown[])[0];
  const cost = loadFixture("codexbar-cost-codex.json");
  const client = new CodexbarClient({
    fetchJson: async (url) => {
      if (url.endsWith("/usage")) return [codex, claude, minimax];
      if (url.includes("/cost")) return cost;
      return [];
    },
  });
  const usages = await client.getAllUsage();
  assert.deepEqual(usages.map((u) => u.provider), ["codex", "claude", "minimax"]);
  assert.equal(usages[0].costTodayUsd, 4.2);
});

test("getAllUsage returns [] when the server is unreachable", async () => {
  const client = new CodexbarClient({
    fetchJson: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.deepEqual(await client.getAllUsage(), []);
});

test("CodexbarClient.getUsage never throws on transport failure", async () => {
  const client = new CodexbarClient({
    fetchJson: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const u = await client.getUsage("codex");
  assert.equal(u.ok, false);
  assert.match(u.error ?? "", /ECONNREFUSED/);
});
