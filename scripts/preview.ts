/**
 * Headless preview harness.
 *
 * Renders the full Muxboard layout — 8 keys + the 4-segment LCD strip — from
 * the test fixtures into PNGs under ./out, so the visuals can be reviewed
 * without a physical Stream Deck+ or the desktop app.
 *
 *   npm run preview
 *   open out/dashboard.png
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeNotifications } from "../src/core/cmux/normalize.js";
import { normalizeWorktrees } from "../src/core/orca/normalize.js";
import {
  normalizeUsageResponse,
  extractCostToday,
  extractTokensToday,
} from "../src/core/codexbar/normalize.js";
import { sortNewestFirst, triageOrder, assignSlots, KEY_COUNT } from "../src/core/cmux/sort.js";
import type { AttentionItem } from "../src/core/types.js";
import { renderKey, renderEmptyKey, renderSourceOffline, KEY_SIZE } from "../src/core/render/keyRender.js";
import { renderLcdSegments, SEG_W, SEG_H } from "../src/core/render/lcdRender.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "out");
const fixtures = join(root, "test", "fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

function svgToPng(svg: string, width: number): Buffer {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: width } });
  return r.render().asPng();
}

function main(): void {
  mkdirSync(outDir, { recursive: true });
  const nowMs = Date.parse("2026-06-20T12:10:00Z");

  // --- Keys ----------------------------------------------------------------
  // Demo workspace context: cmux colors + a "working" pane, keyed to the
  // fixture workspace_ids, so the preview shows the border + status states.
  const workspaces = new Map([
    ["6ECA42AE-78F8-4CD4-8304-93318D3CDB65", { title: "RCJ Scoreboard", message: "", color: "#C0392B", activity: "waiting" as const }],
    ["AEEAE30E-2F47-453A-A836-9F449716C7C8", { title: "RoboCup CMS", message: "", color: "#922B21", activity: "waiting" as const }],
    ["P1P1P1P1-0000-0000-0000-0000000P1P11", { title: "pizza-service", message: "", color: "#006B6B", activity: "working" as const }],
    ["5A1A04C5-9FF8-4445-ACD7-E10E482E9DEB", { title: "fieldtheory-cli", message: "", activity: "working" as const }],
  ]);
  const base = sortNewestFirst(
    normalizeNotifications(loadFixture("cmux-notifications.json"), {}, { workspaces }),
  );
  // Showcase the live states: flag one waiting pane as cmux "Needs input", and
  // add a running pane with no notification (sorted to the end via triage).
  const running: AttentionItem = {
    id: "demo-run", source: "cmux", agent: "claude", workspaceId: "demo-run", title: "muxboard",
    reason: "waiting", activity: "working", color: "#2f6df6", body: "", message: "",
    createdAt: "2026-06-20T12:09:30Z", synthetic: true,
  };
  const orcaRaw = loadFixture("orca-worktree-ps.json") as { result: { worktrees: unknown[] } };
  const orcaItems = normalizeWorktrees(orcaRaw.result.worktrees, new Date("2026-06-23T12:05:00Z").toISOString());
  const items = triageOrder([
    ...base.map((it) =>
      it.title === "RCJ Scoreboard"
        ? { ...it, reason: "waiting" as const, activity: "waiting" as const, needsInput: true }
        : it,
    ),
    running,
    ...orcaItems,
  ]);
  const slots = assignSlots(items, 0);
  // Render the resting board (offset 0): the queue-position index only appears
  // once you scroll (col-0 dial), so omit slotNumber here to match the device.
  const keySvgs = slots.map((item, i) =>
    item ? renderKey(item, { nowMs }) : renderEmptyKey(i + 1),
  );
  keySvgs.forEach((svg, i) => writeFileSync(join(outDir, `key-${i + 1}.png`), svgToPng(svg, KEY_SIZE)));

  // --- LCD -----------------------------------------------------------------
  const codexRaw = loadFixture("codexbar-usage-codex.json");
  const codex = normalizeUsageResponse(codexRaw, "codex");
  const codexCost = loadFixture("codexbar-cost-codex.json");
  codex.costTodayUsd = extractCostToday(codexCost);
  codex.tokensToday = extractTokensToday(codexCost);
  const claude = normalizeUsageResponse(loadFixture("codexbar-usage-claude.json"), "claude");
  const minimax = normalizeUsageResponse(loadFixture("codexbar-usage-minimax.json"), "minimax");
  // Providers are discovered from CodexBar; here three are enabled, 4th blank.
  const usages = [codex, claude, minimax];
  const segs = renderLcdSegments(usages, { nowMs, stale: false, numberMode: "remaining" });
  segs.forEach((svg, i) => writeFileSync(join(outDir, `lcd-${i + 1}.png`), svgToPng(svg, SEG_W)));
  // Pace-mode variant (the rightmost-dial toggle), for visual review.
  renderLcdSegments(usages, { nowMs, stale: false, numberMode: "pace" }).forEach((svg, i) =>
    writeFileSync(join(outDir, `lcd-${i + 1}-pace.png`), svgToPng(svg, SEG_W)),
  );

  // --- Composite dashboard -------------------------------------------------
  writeFileSync(join(outDir, "dashboard.svg"), composite(keySvgs, segs));
  writeFileSync(join(outDir, "dashboard.png"), svgToPng(composite(keySvgs, segs), 880));

  // --- Offline scenario (acceptance #6) ------------------------------------
  const offlineKeys = [renderSourceOffline("cmux"), ...Array.from({ length: 7 }, (_, i) => renderEmptyKey(i + 2))];
  const offlineSegs = renderLcdSegments([], { nowMs, stale: true, numberMode: "remaining" });
  writeFileSync(join(outDir, "dashboard-offline.png"), svgToPng(composite(offlineKeys, offlineSegs), 880));

  console.log(`Rendered ${KEY_COUNT} keys + 4 LCD segments to ${outDir}`);
  console.log("Open out/dashboard.png (and dashboard-offline.png) to review the layout.");
}

/** Lay the 8 keys (4×2) above the 800×100 LCD strip on a dark board. */
function composite(keySvgs: string[], segs: string[]): string {
  const pad = 20;
  const gap = 12;
  const board = pad * 2 + KEY_SIZE * 4 + gap * 3;
  const keysH = KEY_SIZE * 2 + gap;
  const lcdW = SEG_W * 4;
  const lcdScale = (board - pad * 2) / lcdW;
  const lcdH = SEG_H * lcdScale;
  const height = pad * 3 + keysH + lcdH;

  const keyTiles = keySvgs
    .map((svg, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const x = pad + col * (KEY_SIZE + gap);
      const y = pad + row * (KEY_SIZE + gap);
      return placeSvg(svg, x, y, KEY_SIZE, KEY_SIZE);
    })
    .join("\n");

  const lcdY = pad * 2 + keysH;
  const segW = (board - pad * 2) / 4;
  const lcdTiles = segs
    .map((svg, i) => placeSvg(svg, pad + i * segW, lcdY, segW, lcdH))
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${board}" height="${height}" viewBox="0 0 ${board} ${height}">
  <rect width="${board}" height="${height}" rx="16" fill="#0a0a0b"/>
  ${keyTiles}
  ${lcdTiles}
</svg>`;
}

/** Embed an SVG string as a nested <svg> at a position/size. */
function placeSvg(svg: string, x: number, y: number, w: number, h: number): string {
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? `0 0 ${w} ${h}`;
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${viewBox}">${inner}</svg>`;
}

main();
