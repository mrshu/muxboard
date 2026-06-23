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

import { normalizeWorktrees } from "../src/core/orca/normalize.js";

const NOW = "2026-06-23T12:00:00Z";

function wt(over: Record<string, unknown>): Record<string, unknown> {
  return {
    worktreeId: "repo::/p", repo: "myrepo", displayName: "feat", path: "/p",
    status: "active", unread: false, lastOutputAt: 1782000000000, agents: [], ...over,
  };
}

test("orca permission worktree -> blocked + needsInput", () => {
  const items = normalizeWorktrees([wt({
    status: "permission",
    agents: [{ state: "waiting", agentType: "claude", lastAssistantMessage: "May I run tests?", stateStartedAt: 1782000000000 }],
  })], NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "orca");
  assert.equal(items[0].reason, "blocked");
  assert.equal(items[0].needsInput, true);
  assert.equal(items[0].activity, "waiting");
  assert.equal(items[0].agent, "claude");
  assert.equal(items[0].message, "May I run tests?");
  assert.equal(items[0].workspaceId, "repo::/p");
});

test("orca done+interrupted -> failed; clean done -> finished", () => {
  const failed = normalizeWorktrees([wt({ status: "done", agents: [{ state: "done", agentType: "codex", interrupted: true }] })], NOW);
  assert.equal(failed[0].reason, "failed");
  assert.equal(failed[0].agent, "codex");
  const fin = normalizeWorktrees([wt({ status: "done", agents: [{ state: "done", agentType: "claude", interrupted: false }] })], NOW);
  assert.equal(fin[0].reason, "finished");
});

test("orca working worktree -> synthetic running item", () => {
  const items = normalizeWorktrees([wt({ status: "working", agents: [{ state: "working", agentType: "claude", stateStartedAt: 1782000000000 }] })], NOW);
  assert.equal(items[0].activity, "working");
  assert.equal(items[0].synthetic, true);
});

test("orca active/inactive worktrees are not surfaced; unknown agent type maps to unknown", () => {
  assert.equal(normalizeWorktrees([wt({ status: "active" }), wt({ status: "inactive" })], NOW).length, 0);
  const g = normalizeWorktrees([wt({ status: "done", agents: [{ state: "done", agentType: "gemini" }] })], NOW);
  assert.equal(g[0].agent, "unknown");
});
