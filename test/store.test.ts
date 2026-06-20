import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/services/store.js";
import { normalizeNotifications } from "../src/core/cmux/normalize.js";
import { loadFixture } from "./helpers.js";

function freshStore(): Store {
  const store = new Store(["codex", "claude"]);
  store.setAttention(normalizeNotifications(loadFixture("cmux-notifications.json")), false);
  return store;
}

test("store sorts items newest-first into items", () => {
  const store = freshStore();
  const { items } = store.getState();
  // newest createdAt is the codex 12:05 failure
  assert.equal(items[0].agent, "codex");
  assert.equal(items[0].reason, "failed");
});

test("agent filter narrows items and resets offset", () => {
  const store = freshStore();
  // all -> claude
  store.cycleFilter(1);
  let s = store.getState();
  assert.equal(s.filter, "claude");
  assert.ok(s.items.every((i) => i.agent === "claude"));
  assert.equal(s.items.length, 2);

  store.resetFilter();
  assert.equal(store.getState().filter, "all");
});

test("providers are kept in display order for the LCD segments", () => {
  const store = new Store(["codex", "claude", "minimax", "kimi"]);
  assert.deepEqual(store.getState().providers, ["codex", "claude", "minimax", "kimi"]);
});

test("scroll offset only moves when there are >8 items", () => {
  const store = freshStore(); // 5 items
  store.scrollBy(1);
  assert.equal(store.getState().offset, 0);
});

test("subscribers are notified on changes", () => {
  const store = new Store(["codex"]);
  let calls = 0;
  store.subscribe(() => calls++);
  store.setAttention([], false);
  store.cycleFilter(1);
  assert.ok(calls >= 2);
});

test("newestVisible returns slot-0 item", () => {
  const store = freshStore();
  const top = store.newestVisible();
  assert.equal(top?.agent, "codex");
});
