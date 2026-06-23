import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNotifications } from "../src/core/cmux/normalize.js";
import { Store } from "../src/core/services/store.js";
import type { AttentionItem } from "../src/core/types.js";

test("cmux notifications are stamped with source 'cmux'", () => {
  const items = normalizeNotifications([
    { id: "n1", workspace_id: "w1", title: "Claude Code", body: "done", created_at: "2026-06-23T10:00:00Z" },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "cmux");
});

function item(p: Partial<AttentionItem> & { id: string; source: AttentionItem["source"] }): AttentionItem {
  return {
    agent: "claude", workspaceId: p.id, title: p.id, reason: "waiting",
    activity: "waiting", body: "", message: "", createdAt: "2026-06-23T10:00:00Z",
    ...p,
  };
}

test("store merges cmux and orca slices without clobbering", () => {
  const store = new Store();
  store.setAttention([item({ id: "c1", source: "cmux" })], false, "cmux");
  store.setAttention([item({ id: "o1", source: "orca" })], false, "orca");
  const ids = store.getState().items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["c1", "o1"]); // a second-source push keeps the first
});

test("same workspaceId in two sources is NOT deduped together", () => {
  const store = new Store();
  store.setAttention([item({ id: "x", workspaceId: "repo", source: "cmux" })], false, "cmux");
  store.setAttention([item({ id: "x", workspaceId: "repo", source: "orca" })], false, "orca");
  assert.equal(store.getState().items.length, 2);
});
