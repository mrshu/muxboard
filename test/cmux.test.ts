import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAgent,
  detectReason,
  normalizeNotifications,
} from "../src/core/cmux/normalize.js";
import { parseCodingAgents, toAgentKind } from "../src/core/cmux/agents.js";
import {
  assignSlots,
  clampOffset,
  coordinatesToSlot,
  dedupeNewestPerWorkspace,
  sortNewestFirst,
} from "../src/core/cmux/sort.js";
import type { AttentionItem } from "../src/core/types.js";
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

test("parseCodingAgents maps workspace → agent from running processes", () => {
  const map = parseCodingAgents(loadFixture("cmux-top.json"));
  assert.equal(map.get("WS-CLAUDE"), "claude");
  assert.equal(map.get("WS-CODEX"), "codex");
  assert.equal(map.get("WS-PLAIN"), undefined); // no coding-agent process
  assert.equal(toAgentKind("gemini"), "unknown");
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

test("normalize uses the workspace message for the key band, falling back to body", () => {
  const raw = [
    { id: "a", title: "Claude Code", body: "Claude is waiting for your input", workspace_id: "WS1", created_at: "2026-06-20T12:00:00Z" },
    { id: "b", title: "Codex", body: "Ran the update: 23 synced", workspace_id: "WS2", created_at: "2026-06-20T12:00:00Z" },
  ];
  const messages = new Map([["WS1", "let's start from dev on #12"]]);
  const [a, b] = normalizeNotifications(raw, {}, { messages });
  assert.equal(a.message, "let's start from dev on #12"); // workspace message
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
