/**
 * Validates the render/state transforms against the fixtures and prints a
 * human-readable report plus PASS/FAIL checks tied to the acceptance criteria.
 * No device or services required:
 *
 *   npm run validate
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeNotifications } from "../src/core/cmux/normalize.js";
import { normalizeUsageResponse, extractCostToday } from "../src/core/codexbar/normalize.js";
import { sortNewestFirst, assignSlots } from "../src/core/cmux/sort.js";
import { formatAge } from "../src/core/render/format.js";
import { routeStatus } from "../src/core/render/lcdRender.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "test", "fixtures");
const load = (n: string): unknown => JSON.parse(readFileSync(join(fixtures, n), "utf8"));

const NOW = Date.parse("2026-06-20T12:10:00Z");
let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
}

console.log("Muxboard transform validation\n=============================\n");

// --- cmux attention queue --------------------------------------------------
const items = sortNewestFirst(normalizeNotifications(load("cmux-notifications.json")));
const slots = assignSlots(items, 0);

console.log("Attention keys (physical order 1 2 3 4 / 5 6 7 8):");
for (let r = 0; r < 2; r++) {
  const row = [];
  for (let c = 0; c < 4; c++) {
    const it = slots[r * 4 + c];
    row.push(
      it
        ? `${(it.agent + "/" + it.reason).padEnd(16)} ${formatAge(it.createdAt, NOW).padStart(3)}`
        : "· empty".padEnd(20),
    );
  }
  console.log("  " + row.join(" | "));
}
console.log();

console.log("Acceptance checks:");
check("keys ordered newest-first", isNewestFirst(slots));
check("slot 1 (key 1) is the newest item (codex/failed)", slots[0]?.agent === "codex" && slots[0]?.reason === "failed");
check("empty slots render as null (keys 6-8)", slots[5] === null && slots[6] === null && slots[7] === null);
check(
  "agents detected for claude/codex/pi",
  items.some((i) => i.agent === "claude") &&
    items.some((i) => i.agent === "codex") &&
    items.some((i) => i.agent === "pi"),
);
check(
  "reasons cover failed/blocked/waiting/finished",
  ["failed", "blocked", "waiting", "finished"].every((r) => items.some((i) => i.reason === r)),
);
console.log();

// --- CodexBar LCD ----------------------------------------------------------
const codex = normalizeUsageResponse(load("codexbar-usage-codex.json"), "codex");
codex.costTodayEur = extractCostToday(load("codexbar-cost-codex.json"));
const claude = normalizeUsageResponse(load("codexbar-usage-claude.json"), "claude");
const kimi = normalizeUsageResponse(load("codexbar-usage-kimi.json"), "kimi");

console.log("CodexBar (codex):");
console.log(
  `  SESSION ${codex.session?.remainingPercent}% left · WEEKLY ${codex.weekly?.remainingPercent}% left · ROUTE ${routeStatus(codex, false)} · €${codex.costTodayEur?.toFixed(2)} today`,
);
console.log();

console.log("Acceptance checks:");
check("codex session+weekly parsed (top-level shape)", codex.session?.usedPercent === 1 && codex.weekly?.usedPercent === 25);
check("claude parsed (nested usage shape)", claude.ok && claude.session?.usedPercent === 3);
check("kimi error surfaces as unavailable", !kimi.ok && !!kimi.error);
check("offline provider yields OFF route", routeStatus(undefined, false) === "OFF");
check("cost today extracted", codex.costTodayEur === 4.2);
console.log();

console.log(failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);

function isNewestFirst(s: (typeof slots)): boolean {
  const present = s.filter((x): x is NonNullable<typeof x> => x !== null);
  for (let i = 1; i < present.length; i++) {
    if (Date.parse(present[i - 1].createdAt) < Date.parse(present[i].createdAt)) return false;
  }
  return true;
}
