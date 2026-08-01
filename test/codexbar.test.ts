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

test("commandcode: parses the credit bucket, single monthly window, no weekly", () => {
  const raw = loadFixture("codexbar-usage-commandcode.json");
  const u = normalizeUsageResponse(raw, "commandcode");
  assert.equal(u.ok, true);
  assert.equal(u.provider, "commandcode");
  // CodexBar surfaces one window (the monthly credit bucket) as `primary`.
  assert.equal(u.session?.usedPercent, 0);
  assert.equal(u.weekly, undefined);
  // "Go · $0.00 of $10.00" → label + spend/allowance in dollars.
  assert.equal(u.credits?.label, "Go");
  assert.equal(u.credits?.spent, 0);
  assert.equal(u.credits?.total, 10);
  assert.equal(u.credits?.unit, "usd");
});

test("commandcode: parses monthly spend with an optional purchased-credit suffix", () => {
  const withSpend = normalizeUsageResponse(
    [
      {
        provider: "commandcode",
        usage: {
          primary: { usedPercent: 42, resetsAt: "2026-07-20T12:10:00Z" },
          loginMethod: "Pro · $12.50 of $30.00 · + $5.00 credits",
        },
      },
    ],
    "commandcode",
  );
  assert.equal(withSpend.credits?.label, "Pro");
  assert.equal(withSpend.credits?.spent, 12.5);
  assert.equal(withSpend.credits?.total, 30);
  assert.equal(withSpend.credits?.unit, "usd");
});

test("credit parsing stays scoped to CommandCode and Perplexity", () => {
  // Claude's "Claude Max" loginMethod is not a CommandCode credit summary.
  const claude = normalizeUsageResponse(loadFixture("codexbar-usage-claude.json"), "claude");
  assert.equal(claude.credits, undefined);

  // Alibaba uses the same count-shaped strings for 5h, weekly, and monthly
  // rate-limit windows — CodexBar builds them as "\(used) / \(total) used"
  // (AlibabaCodingPlanUsageSnapshot.usageDetail). It must retain ordinary S/W.
  const alibaba = normalizeUsageResponse(
    [
      {
        provider: "alibaba",
        usage: {
          primary: { usedPercent: 20, windowMinutes: 300, resetDescription: "20 / 100 used" },
          secondary: { usedPercent: 30, windowMinutes: 10080, resetDescription: "300 / 1000 used" },
          tertiary: { usedPercent: 40, windowMinutes: 43200, resetDescription: "4000 / 10000 used" },
        },
      },
    ],
    "alibaba",
  );
  assert.equal(alibaba.credits, undefined);
  assert.equal(alibaba.session?.usedPercent, 20);
  assert.equal(alibaba.weekly?.usedPercent, 30);

  // Kilo emits "\(used)/\(total) credits" (KiloUsageFetcher) — byte-identical in
  // shape to Perplexity's own string, so only the provider id can separate them.
  const kilo = normalizeUsageResponse(
    [
      {
        provider: "kilo",
        usage: {
          primary: { usedPercent: 10, resetDescription: "100/1000 credits" },
          secondary: { usedPercent: 50, resetDescription: "$5.00 / $10.00" },
        },
      },
    ],
    "kilo",
  );
  assert.equal(kilo.credits, undefined);
  assert.equal(kilo.session?.usedPercent, 10);
  assert.equal(kilo.weekly?.usedPercent, 50);
});

test("perplexity: gauges the credits window, skips the empty bonus, count unit", () => {
  const u = normalizeUsageResponse(loadFixture("codexbar-usage-perplexity.json"), "perplexity");
  assert.equal(u.ok, true);
  // The gauge is "0/12000 credits" (Purchased), not the empty "0/0 bonus".
  assert.equal(u.session?.usedPercent, 0);
  assert.equal(u.weekly, undefined);
  assert.equal(u.credits?.spent, 0);
  assert.equal(u.credits?.total, 12000);
  assert.equal(u.credits?.unit, "credits");
});

test("perplexity: a bonus-only (0/0) account stays credit-framed, not a weekly cap", () => {
  const u = normalizeUsageResponse(
    [
      {
        provider: "perplexity",
        usage: {
          primary: null,
          // Upstream always emits both pools, so an empty account carries a 0/0
          // purchased bucket alongside the 0/0 bonus.
          secondary: { usedPercent: 100, resetDescription: "0/0 bonus" },
          tertiary: { usedPercent: 100, resetDescription: "0/0 credits" },
          identity: { providerID: "perplexity" },
        },
      },
    ],
    "perplexity",
  );
  assert.equal(u.ok, true);
  // No credit anywhere — must NOT fall back to the S/W layout (which would
  // render a misleading fully-used weekly bar).
  assert.equal(u.weekly, undefined);
  assert.ok(u.session);
  assert.ok(u.credits);
  assert.equal(u.credits?.total, 0);
});

test("perplexity: a fully-spent recurring grant keeps its own numbers, not an empty pool", () => {
  const u = normalizeUsageResponse(
    [
      {
        provider: "perplexity",
        usage: {
          // Spent the whole monthly grant, with no purchased or promotional credit.
          // Upstream encodes the drained pools as usedPercent 100, so an
          // availability-first policy must not let a 0/0 bucket win here.
          primary: { usedPercent: 100, resetDescription: "1000/1000 credits" },
          secondary: { usedPercent: 100, resetDescription: "0/0 bonus" },
          tertiary: { usedPercent: 100, resetDescription: "0/0 credits" },
        },
      },
    ],
    "perplexity",
  );
  assert.equal(u.session?.usedPercent, 100);
  assert.equal(u.credits?.spent, 1000);
  assert.equal(u.credits?.total, 1000);
  assert.equal(u.credits?.unit, "credits");
});

test("perplexity: an available purchased pool wins once the recurring grant is spent", () => {
  const u = normalizeUsageResponse(
    [
      {
        provider: "perplexity",
        usage: {
          primary: { usedPercent: 100, resetDescription: "1000/1000 credits" },
          secondary: { usedPercent: 100, resetDescription: "0/0 bonus" },
          tertiary: { usedPercent: 25, resetDescription: "3000/12000 credits" },
        },
      },
    ],
    "perplexity",
  );
  assert.equal(u.session?.usedPercent, 25);
  assert.equal(u.credits?.spent, 3000);
  assert.equal(u.credits?.total, 12000);
});

test("perplexity: purchased credit outranks promotional when both are available", () => {
  // Both fallback pools have credit left, so the tertiary-before-secondary order
  // is what decides — matching CodexBar's recurring → purchased → promotional
  // attribution. Without this, swapping the fallback order stays green.
  const u = normalizeUsageResponse(
    [
      {
        provider: "perplexity",
        usage: {
          primary: null,
          secondary: { usedPercent: 0, resetDescription: "0/100 bonus" },
          tertiary: { usedPercent: 0, resetDescription: "0/12000 credits" },
        },
      },
    ],
    "perplexity",
  );
  assert.equal(u.credits?.total, 12000);
  assert.equal(u.credits?.unit, "credits");
});

test("commandcode: a known allowance renders without a monthly window", () => {
  // Decoupling check, not a live shape: upstream pairs an "$x of $y" grant with a
  // primary window (both derive from the plan allowance), so this payload isn't
  // reachable today. It pins that a known allowance never depends on the window
  // to render — no window carries a usedPercent here, so `windowSource` reads the
  // top level.
  const u = normalizeUsageResponse(
    [{ provider: "commandcode", loginMethod: "Go · $4.00 of $10.00" }],
    "commandcode",
  );
  assert.equal(u.ok, true);
  assert.equal(u.weekly, undefined);
  assert.equal(u.credits?.spent, 4);
  assert.equal(u.credits?.total, 10);
  assert.equal(u.credits?.unit, "usd");
});

test("perplexity: keeps an available recurring grant ahead of a larger purchased pool", () => {
  const u = normalizeUsageResponse(
    [
      {
        provider: "perplexity",
        usage: {
          primary: { usedPercent: 90, resetDescription: "900/1000 credits" },
          secondary: { usedPercent: 100, resetDescription: "0/0 bonus" },
          tertiary: { usedPercent: 0, resetDescription: "0/12000 credits" },
        },
      },
    ],
    "perplexity",
  );
  assert.equal(u.session?.usedPercent, 90);
  assert.equal(u.credits?.spent, 900);
  assert.equal(u.credits?.total, 1000);
});

test("perplexity: uses an expiring promotional balance before an exhausted purchased pool", () => {
  const u = normalizeUsageResponse(
    [
      {
        provider: "perplexity",
        usage: {
          primary: null,
          secondary: { usedPercent: 50, resetDescription: "50/100 bonus · exp. Aug 31" },
          tertiary: { usedPercent: 100, resetDescription: "0/0 credits" },
        },
      },
    ],
    "perplexity",
  );
  assert.equal(u.session?.usedPercent, 50);
  assert.equal(u.credits?.spent, 50);
  assert.equal(u.credits?.total, 100);
  assert.equal(u.credits?.unit, "bonus");
});

test("normalizes nested usage when primary is null but secondary is live", () => {
  // Real Codex shape from newer CodexBar builds: windows nest under `usage`,
  // the 5h `primary` is null, and only the weekly `secondary` is present. The
  // shape detector must still pick the nested object, not fall back to the
  // empty top level and drop the weekly gauge.
  const raw = [
    {
      provider: "codex",
      usage: {
        primary: null,
        secondary: { usedPercent: 13, windowMinutes: 10080, resetsAt: "2026-07-19T19:16:40Z" },
        identity: { accountEmail: "openai@example.com" },
        updatedAt: "2026-07-14T10:06:34Z",
      },
    },
  ];
  const u = normalizeUsageResponse(raw, "codex");
  assert.equal(u.ok, true);
  assert.equal(u.session, undefined);
  assert.equal(u.weekly?.usedPercent, 13);
  assert.equal(u.weekly?.remainingPercent, 87);
  assert.equal(u.weekly?.windowMinutes, 10080);
  assert.equal(u.account, "openai@example.com");
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

test("extractCostToday returns the matched day, not just the newest", () => {
  const raw = loadFixture("codexbar-cost-codex.json");
  assert.equal(extractCostToday(raw, "2026-06-20"), 4.2);
  assert.equal(extractCostToday(raw, "2026-06-18"), 70.95);
  // No entry for the day → undefined, so a stale day is never shown as "today".
  assert.equal(extractCostToday(raw, "2026-07-24"), undefined);
  // No day given → falls back to the most recent recorded day.
  assert.equal(extractCostToday(raw), 4.2);
  assert.equal(extractCostToday([], "2026-06-20"), undefined);
});

test("extractTokensToday returns the matched day's token count", () => {
  const raw = loadFixture("codexbar-cost-codex.json");
  assert.equal(extractTokensToday(raw, "2026-06-20"), 500);
  assert.equal(extractTokensToday(raw, "2026-07-24"), undefined);
  assert.equal(extractTokensToday(raw), 500); // newest fallback
  assert.equal(extractTokensToday([]), undefined);
});

test("CodexbarClient.getUsage merges usage + today's cost via injected fetcher", async () => {
  const usage = loadFixture("codexbar-usage-codex.json");
  const cost = loadFixture("codexbar-cost-codex.json");
  const client = new CodexbarClient({
    fetchJson: async (url) => (url.includes("/usage") ? usage : cost),
    now: () => new Date(2026, 5, 20, 12, 0, 0).getTime(),
  });
  const u = await client.getUsage("codex");
  assert.equal(u.ok, true);
  assert.equal(u.costTodayUsd, 4.2); // date-matched to the 2026-06-20 entry
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
    now: () => new Date(2026, 5, 20, 12, 0, 0).getTime(),
  });
  const usages = await client.getAllUsage();
  assert.deepEqual(usages.map((u) => u.provider), ["codex", "claude", "minimax"]);
  assert.equal(usages[0].costTodayUsd, 4.2);
});

test("getAllUsage falls back to per-provider fetch when aggregate /usage is empty", async () => {
  // Some CodexBar builds return an empty aggregate; the per-provider endpoint
  // still works. Passing known providers must recover them individually.
  const codex = loadFixture("codexbar-usage-codex.json");
  const cost = loadFixture("codexbar-cost-codex.json");
  const client = new CodexbarClient({
    fetchJson: async (url) => {
      if (url.endsWith("/usage")) return [];
      if (url.includes("/usage?provider=codex")) return codex;
      if (url.includes("/cost")) return cost;
      return [];
    },
    now: () => new Date(2026, 5, 20, 12, 0, 0).getTime(),
  });
  const usages = await client.getAllUsage(["codex"]);
  assert.deepEqual(usages.map((u) => u.provider), ["codex"]);
  assert.equal(usages[0].ok, true);
  assert.equal(usages[0].costTodayUsd, 4.2);
});

test("getAllUsage fills a known provider the aggregate omitted", async () => {
  // Aggregate returns claude but drops codex (e.g. after codex changed shape);
  // codex must be fetched individually and merged in, not lost.
  const codex = loadFixture("codexbar-usage-codex.json");
  const claude = (loadFixture("codexbar-usage-claude.json") as unknown[])[0];
  const cost = loadFixture("codexbar-cost-codex.json");
  const client = new CodexbarClient({
    fetchJson: async (url) => {
      if (url.endsWith("/usage")) return [claude];
      if (url.includes("/usage?provider=codex")) return codex;
      if (url.includes("/cost")) return cost;
      return [];
    },
  });
  const usages = await client.getAllUsage(["claude", "codex"]);
  // Documented contract: aggregate order first, then recovered providers appended.
  assert.deepEqual(
    usages.map((u) => u.provider),
    ["claude", "codex"],
  );
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

test("commandcode: parses a grant summary with no plan segment", () => {
  // The plan segment is optional in CodexBar's builder. It always accompanies an
  // "$x of $y" grant today (the total *is* the plan's allowance), so this is
  // drift insurance against a catalog plan with an empty display name — not a
  // state reachable now.
  for (const loginMethod of ["$0.00 of $10.00", "$0.00 of $10.00 · + $5.00 credits"]) {
    const u = normalizeUsageResponse(
      [
        {
          provider: "commandcode",
          usage: {
            primary: { usedPercent: 0, resetsAt: "2026-07-20T12:10:00Z" },
            loginMethod,
          },
        },
      ],
      "commandcode",
    );
    assert.equal(u.credits?.spent, 0, loginMethod);
    assert.equal(u.credits?.total, 10, loginMethod);
    assert.equal(u.credits?.label, undefined, loginMethod);
    assert.equal(u.weekly, undefined, loginMethod);
  }
});

test("commandcode: formatUSD drops cents and groups at >= $100", () => {
  // maximumFractionDigits is 0 for values >= 100, so large grants arrive as
  // "$1,000" rather than "$1,000.00".
  const u = normalizeUsageResponse(
    [
      {
        provider: "commandcode",
        usage: {
          primary: { usedPercent: 15, resetsAt: "2026-07-20T12:10:00Z" },
          loginMethod: "Scale · $150 of $1,000",
        },
      },
    ],
    "commandcode",
  );
  assert.equal(u.credits?.label, "Scale");
  assert.equal(u.credits?.spent, 150);
  assert.equal(u.credits?.total, 1000);
});
