import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAgent,
  detectReason,
  normalizeNotifications,
} from "../src/core/cmux/normalize.js";
import {
  assignSlots,
  clampOffset,
  coordinatesToSlot,
  sortNewestFirst,
} from "../src/core/cmux/sort.js";
import type { AttentionItem } from "../src/core/types.js";
import { loadFixture } from "./helpers.js";

test("detectAgent maps titles to agent kinds", () => {
  assert.equal(detectAgent("Claude Code"), "claude");
  assert.equal(detectAgent("Codex CLI"), "codex");
  assert.equal(detectAgent("pi-agent"), "pi");
  assert.equal(detectAgent("π"), "pi");
  assert.equal(detectAgent("fieldtheory-cli"), "unknown");
});

test("detectReason picks the strongest signal from the body", () => {
  assert.equal(detectReason("Task failed: build error"), "failed");
  assert.equal(detectReason("Claude needs your permission"), "blocked");
  assert.equal(detectReason("Claude is waiting for your input"), "waiting");
  assert.equal(detectReason("Run complete: tests passing"), "finished");
  assert.equal(detectReason("some neutral status"), "unknown");
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
