import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAgent,
  detectReason,
  normalizeNotifications,
} from "../src/core/cmux/normalize.js";
import { parseCodingAgents, parseSurfaceActivity, toAgentKind } from "../src/core/cmux/agents.js";
import { hasSpinnerGlyph } from "../src/core/cmux/workspaces.js";
import {
  assignSlots,
  clampOffset,
  coordinatesToSlot,
  dedupeNewestPerWorkspace,
  isDecision,
  sortNewestFirst,
  triageOrder,
} from "../src/core/cmux/sort.js";
import type { AttentionItem } from "../src/core/types.js";

test("buildRunningItems synthesizes working panes with no notification", async () => {
  const { buildRunningItems } = await import("../src/core/cmux/normalize.js");
  const workspaces = new Map([
    ["w-run", { title: "Building", message: "", color: "#abc", activity: "working" as const }],
    ["w-idle", { title: "Idle", message: "", activity: "waiting" as const }],
    ["w-has-notif", { title: "Notified", message: "", activity: "working" as const }],
  ]);
  const agents = new Map([["w-run", "claude" as const]]);
  const items = buildRunningItems(workspaces, agents, new Set(["w-has-notif"]), "2026-06-21T12:00:00Z");
  assert.equal(items.length, 1); // only w-run (idle excluded, notified excluded)
  assert.equal(items[0].workspaceId, "w-run");
  assert.equal(items[0].agent, "claude");
  assert.equal(items[0].activity, "working");
  assert.equal(items[0].synthetic, true);
});

test("buildRunningItems synthesizes a running pane from the event stream when the title has no spinner", async () => {
  const { buildRunningItems } = await import("../src/core/cmux/normalize.js");
  // A custom-titled workspace: cmux omits the spinner glyph from its JSON title,
  // so the title heuristic reads "waiting" even though the agent is running. The
  // event stream's set_status verdict is authoritative and must still surface it.
  const workspaces = new Map([
    ["w-custom", { title: "Bug Review Report", message: "", activity: "waiting" as const }],
  ]);
  const agents = new Map([["w-custom", "claude" as const]]);
  const status = { "w-custom": { state: "running" as const, since: 0 } };
  const items = buildRunningItems(workspaces, agents, new Set(), "2026-06-21T12:00:00Z", status);
  assert.equal(items.length, 1);
  assert.equal(items[0].workspaceId, "w-custom");
  assert.equal(items[0].activity, "working");
  assert.equal(items[0].synthetic, true);
});

test("triageOrder pins needs-input above plain waiting, below permission", () => {
  const mk = (id: string, extra: Partial<AttentionItem>): AttentionItem => ({
    id,
    agent: "claude",
    workspaceId: id,
    title: id,
    reason: "waiting",
    activity: "waiting",
    body: "",
    message: "",
    createdAt: "2026-06-20T12:00:00Z",
    ...extra,
  });
  const ordered = triageOrder([
    mk("plain", {}),
    mk("working", { activity: "working" }),
    mk("needs", { needsInput: true }),
    mk("perm", { reason: "blocked" }),
  ]).map((i) => i.id);
  assert.deepEqual(ordered, ["perm", "needs", "plain", "working"]);
});
import { loadFixture } from "./helpers.js";

test("detectAgent maps titles to agent kinds, with alias override", () => {
  assert.equal(detectAgent("Claude Code"), "claude");
  assert.equal(detectAgent("Codex CLI"), "codex");
  assert.equal(detectAgent("pi-agent"), "pi");
  assert.equal(detectAgent("π"), "pi");
  assert.equal(detectAgent("fieldtheory-cli"), "unknown");
  // alias map identifies a custom-named agent cmux doesn't tag
  assert.equal(detectAgent("⠴ fieldtheory-cli", { fieldtheory: "codex" }), "codex");
});

test("detectAgent recognises omp (oh-my-pi) and never confuses it with pi", () => {
  assert.equal(detectAgent("omp"), "omp");
  assert.equal(detectAgent("omp-agent"), "omp");
  assert.equal(detectAgent("⠴ omp session"), "omp");
  // "oh-my-pi" ends in "-pi", which the pi word-boundary rule would match:
  // the omp checks must win.
  assert.equal(detectAgent("oh-my-pi"), "omp");
  assert.equal(detectAgent("oh my pi"), "omp");
  // no substring false-positives
  assert.equal(detectAgent("stomp"), "unknown");
  assert.equal(detectAgent("compare-tool"), "unknown");
});

test("parseCodingAgents maps workspace → agent from running processes", () => {
  const map = parseCodingAgents(loadFixture("cmux-top.json"));
  assert.equal(map.get("WS-CLAUDE"), "claude");
  assert.equal(map.get("WS-CODEX"), "codex");
  assert.equal(map.get("WS-PLAIN"), undefined); // no coding-agent process
  assert.equal(toAgentKind("gemini"), "unknown");
  assert.equal(toAgentKind("omp"), "omp");
});

test("hasSpinnerGlyph matches the braille working spinner, not the ✳ idle marker", () => {
  // cmux prepends an animated braille spinner (U+2800–U+28FF) ONLY while the
  // agent is actively working; a leading ✳ (U+2733) is the idle/waiting marker
  // and must NOT read as working.
  assert.equal(hasSpinnerGlyph("⠂ Fix the reporting status"), true);
  assert.equal(hasSpinnerGlyph("⠴ fieldtheory-cli"), true);
  assert.equal(hasSpinnerGlyph("✳ Claude Code"), false); // idle marker
  assert.equal(hasSpinnerGlyph("✳ View for refs to see assigned matches"), false);
  assert.equal(hasSpinnerGlyph("RCJ Scoreboard"), false);
  assert.equal(hasSpinnerGlyph(""), false);
});

test("parseSurfaceActivity marks a workspace working from a surface-title spinner", () => {
  // The braille spinner survives on the per-surface title even when a custom
  // workspace title has had its glyph stripped — the only "working" signal for a
  // custom-titled agent pane that emits no event-stream hooks.
  const top = {
    windows: [
      {
        workspaces: [
          // Custom (glyph-less) workspace title, but the surface is spinning.
          { id: "WS-WORK", title: "RCJ Scoreboard", panes: [{ surfaces: [{ kind: "surface", title: "⠂ View for refs" }] }] },
          // ✳ on the surface is the idle marker → not working.
          { id: "WS-IDLE", title: "Other", panes: [{ surfaces: [{ kind: "surface", title: "✳ Claude Code" }] }] },
          // No glyph anywhere → not working.
          { id: "WS-PLAIN", title: "Plain", panes: [{ surfaces: [{ kind: "surface", title: "~/w/d/x" }] }] },
        ],
      },
    ],
  };
  const m = parseSurfaceActivity(top);
  assert.equal(m.get("WS-WORK"), "working");
  assert.equal(m.get("WS-IDLE"), undefined);
  assert.equal(m.get("WS-PLAIN"), undefined);
});

test("process-detected agent overrides the title (e.g. codex named 'fieldtheory-cli')", () => {
  const raw = [
    {
      id: "n1",
      title: "⠴ fieldtheory-cli",
      tab_title: "fieldtheory-cli",
      body: "Ran the update again",
      workspace_id: "WS-CODEX",
      created_at: "2026-06-20T12:00:00Z",
    },
  ];
  const map = parseCodingAgents(loadFixture("cmux-top.json"));
  const [item] = normalizeNotifications(raw, {}, { agents: map });
  assert.equal(item.agent, "codex"); // from process, not the custom title
  assert.equal(item.reason, "waiting");
});

test("normalize uses the workspace title + message, falling back to tab/body", () => {
  const raw = [
    { id: "a", title: "Claude Code", tab_title: "~/w/d/r/app", body: "waiting", workspace_id: "WS1", created_at: "2026-06-20T12:00:00Z" },
    { id: "b", title: "Codex", tab_title: "fieldtheory-cli", body: "Ran the update: 23 synced", workspace_id: "WS2", created_at: "2026-06-20T12:00:00Z" },
  ];
  const workspaces = new Map([["WS1", { title: "RCJ Scoreboard", message: "let's start from dev on #12" }]]);
  const [a, b] = normalizeNotifications(raw, {}, { workspaces });
  assert.equal(a.title, "RCJ Scoreboard"); // workspace title wins
  assert.equal(a.message, "let's start from dev on #12");
  assert.equal(b.title, "fieldtheory-cli"); // falls back to tab_title
  assert.equal(b.message, "Ran the update: 23 synced"); // falls back to body
});

test("detectReason: failed only from structured subtitle, never free-form body", () => {
  // "failed"/"error" in the body must NOT trigger failed (it's the agent's text)
  assert.equal(detectReason("Fixed the error; tests were failing, now pass"), "waiting");
  assert.equal(detectReason("Task failed: build error in src/index.ts"), "waiting");
  // failed comes from the structured subtitle/category
  assert.equal(detectReason("Task failed: build error", "Error"), "failed");
  // permission detected from Claude's specific phrasing or subtitle
  assert.equal(detectReason("Claude needs your permission to run a command"), "blocked");
  assert.equal(detectReason("anything", "Permission"), "blocked");
  // everything else is waiting
  assert.equal(detectReason("Claude is waiting for your input"), "waiting");
  assert.equal(detectReason("I'll approve the PR once CI is green"), "waiting");
});

test("parseWorkspaceCpu reads resources.cpu_percent per workspace", async () => {
  const { parseWorkspaceCpu } = await import("../src/core/cmux/agents.js");
  const top = {
    windows: [
      {
        workspaces: [
          { kind: "workspace", id: "busy", resources: { cpu_percent: 698.1 } },
          { kind: "workspace", id: "idle", resources: { cpu_percent: 0 } },
          { kind: "workspace", id: "nores" },
        ],
      },
    ],
  };
  const cpu = parseWorkspaceCpu(top);
  assert.equal(Math.round(cpu.get("busy")!), 698);
  assert.equal(cpu.get("idle"), 0);
  assert.equal(cpu.get("nores"), 0);
});

test("a read permission/failure is demoted to waiting but stays on the board", () => {
  // cmux flips is_read when you merely SEE a notification (not when you resolve
  // it), so read rows stay visible — a read urgent reason just loses its badge,
  // demoting to plain waiting. Unread urgent reasons keep their urgency. (Live
  // "Needs" status re-flags genuine attention; an explicit clear removes it.)
  const base = { id: "n1", workspace_id: "w1" };
  const pendingPerm = normalizeNotifications([
    { ...base, body: "Claude needs your permission to run a command", is_read: false },
  ]);
  assert.equal(pendingPerm[0].reason, "blocked");

  const readPerm = normalizeNotifications([
    { ...base, body: "Claude needs your permission to run a command", is_read: true },
  ]);
  assert.equal(readPerm.length, 1); // still surfaced, not dropped
  assert.equal(readPerm[0].reason, "waiting"); // demoted

  const readFail = normalizeNotifications([
    { ...base, body: "Task failed", subtitle: "Error", is_read: true },
  ]);
  assert.equal(readFail[0].reason, "waiting");
});

test("normalizeNotifications maps the real fixture and drops malformed rows", () => {
  const raw = loadFixture("cmux-notifications.json");
  const items = normalizeNotifications(raw);
  assert.equal(items.length, 5);

  const codex = items.find((i) => i.agent === "codex");
  assert.ok(codex);
  assert.equal(codex?.reason, "failed");
  assert.equal(codex?.repo, "~/w/d/r/codex-playground");

  // missing id/workspace rows are dropped
  const dropped = normalizeNotifications([{ title: "x" }, { id: "a" }, null, 3]);
  assert.equal(dropped.length, 0);
});

function item(id: string, createdAt: string, agent: AttentionItem["agent"] = "claude"): AttentionItem {
  return {
    id,
    agent,
    workspaceId: "w",
    title: id,
    reason: "waiting",
    body: "",
    createdAt,
  };
}

test("sortNewestFirst orders by createdAt desc, stable by id", () => {
  const sorted = sortNewestFirst([
    item("a", "2026-06-20T10:00:00Z"),
    item("c", "2026-06-20T12:00:00Z"),
    item("b", "2026-06-20T11:00:00Z"),
  ]);
  assert.deepEqual(sorted.map((i) => i.id), ["c", "b", "a"]);
});

test("assignSlots fills physical 1 2 3 4 / 5 6 7 8 and pads with null", () => {
  const items = Array.from({ length: 3 }, (_, i) =>
    item(`k${i}`, `2026-06-20T12:0${9 - i}:00Z`),
  );
  const sorted = sortNewestFirst(items);
  const slots = assignSlots(sorted, 0);
  assert.equal(slots.length, 8);
  assert.equal(slots[0]?.id, "k0"); // newest -> key 1
  assert.equal(slots[2]?.id, "k2");
  assert.equal(slots[3], null);
  assert.equal(slots[7], null);
});

test("dedupeNewestPerWorkspace keeps the newest item per workspace", () => {
  const mk = (id: string, ws: string, createdAt: string): AttentionItem => ({
    id,
    agent: "claude",
    workspaceId: ws,
    title: id,
    reason: "waiting",
    body: "",
    createdAt,
  });
  // Workspace W1 has a "done" then a newer "waiting"; W2 has one item.
  const sorted = sortNewestFirst([
    mk("w1-done", "W1", "2026-06-20T12:00:00Z"),
    mk("w1-waiting", "W1", "2026-06-20T12:01:00Z"),
    mk("w2", "W2", "2026-06-20T11:59:00Z"),
  ]);
  const deduped = dedupeNewestPerWorkspace(sorted);
  assert.deepEqual(deduped.map((i) => i.id), ["w1-waiting", "w2"]);
});

test("coordinatesToSlot maps Stream Deck+ keypad coordinates", () => {
  assert.equal(coordinatesToSlot(0, 0), 0); // key 1
  assert.equal(coordinatesToSlot(3, 0), 3); // key 4
  assert.equal(coordinatesToSlot(0, 1), 4); // key 5
  assert.equal(coordinatesToSlot(3, 1), 7); // key 8
});

test("clampOffset keeps the window in range", () => {
  assert.equal(clampOffset(0, 3), 0); // <= 8 items: no scroll
  assert.equal(clampOffset(5, 3), 0);
  assert.equal(clampOffset(-2, 20), 0);
  assert.equal(clampOffset(100, 20), 19);
  assert.equal(clampOffset(5, 20), 5);
});

test("assignSlots respects a scroll offset for >8 items", () => {
  const items = Array.from({ length: 12 }, (_, i) =>
    item(`n${String(i).padStart(2, "0")}`, `2026-06-20T${String(23 - i).padStart(2, "0")}:00:00Z`),
  );
  const sorted = sortNewestFirst(items);
  const slots = assignSlots(sorted, 2);
  assert.equal(slots[0]?.id, sorted[2].id);
  assert.equal(slots[7]?.id, sorted[9].id);
});

test("isDecision flags failed/blocked/needs-input, not plain waiting or working", () => {
  const base = item("d", "2026-06-20T12:00:00Z");
  assert.equal(isDecision({ ...base, reason: "failed" }), true);
  assert.equal(isDecision({ ...base, reason: "blocked" }), true);
  assert.equal(isDecision({ ...base, needsInput: true }), true);
  assert.equal(isDecision({ ...base, reason: "waiting" }), false); // plain waiting
  assert.equal(isDecision({ ...base, reason: "failed", activity: "working" }), false); // working sinks
});

test("triageOrder surfaces a stalled pane above plain waiting and working", () => {
  const ordered = triageOrder([
    { ...item("work", "2026-06-20T12:00:00Z"), activity: "working" },
    { ...item("stall", "2026-06-20T12:00:00Z"), activity: "working", stalled: true },
    item("wait", "2026-06-20T12:00:00Z"),
  ]).map((i) => i.id);
  assert.deepEqual(ordered, ["stall", "wait", "work"]); // stalled(3) < waiting(4) < working(5)
});
