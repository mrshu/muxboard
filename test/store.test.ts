import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/services/store.js";
import { normalizeNotifications } from "../src/core/cmux/normalize.js";
import type { AttentionItem } from "../src/core/types.js";
import { loadFixture } from "./helpers.js";

function freshStore(): Store {
  const store = new Store(["codex", "claude"]);
  store.setAttention(normalizeNotifications(loadFixture("cmux-notifications.json")), false);
  return store;
}

const mkItem = (over: Partial<AttentionItem> & { id: string }): AttentionItem => ({
  source: "cmux", agent: "claude", workspaceId: over.id, title: over.id,
  reason: "waiting", activity: "waiting", body: "", message: "",
  createdAt: "2026-06-20T12:00:00Z", ...over,
});

test("a running pane gone silent past the threshold is marked stalled", () => {
  let now = 1_000_000;
  const store = new Store([], () => now);
  store.setWorkspaceStatus({ w1: { state: "running", since: 0, lastSeen: now - 200_000 } }); // >180s ago
  store.setAttention([mkItem({ id: "a", workspaceId: "w1" })], false);
  const it = store.getState().items.find((i) => i.workspaceId === "w1");
  assert.equal(it?.activity, "working"); // still running, just silent
  assert.equal(it?.stalled, true);
});

test("a fresh running pane (recent lastSeen) or a busy one is NOT stalled", () => {
  let now = 1_000_000;
  const fresh = new Store([], () => now);
  fresh.setWorkspaceStatus({ w1: { state: "running", since: 0, lastSeen: now - 5_000 } });
  fresh.setAttention([mkItem({ id: "a", workspaceId: "w1" })], false);
  assert.equal(fresh.getState().items[0]?.stalled, undefined);
  // A CPU-busy pane is genuine work even if its hooks went quiet.
  const busy = new Store([], () => now);
  busy.setWorkspaceStatus({ w1: { state: "running", since: 0, lastSeen: now - 200_000 } });
  busy.setAttention([mkItem({ id: "a", workspaceId: "w1", busy: true, busySince: now })], false);
  assert.equal(busy.getState().items[0]?.stalled, undefined);
});

test("long-press snooze hides a workspace, then it auto-reverts when the window passes", () => {
  let now = 1_000_000;
  const store = new Store([], () => now);
  const load = () => store.setAttention([mkItem({ id: "a", workspaceId: "w1" }), mkItem({ id: "b", workspaceId: "w2" })], false);
  load();
  assert.equal(store.getState().items.length, 2);
  store.snooze("w1", 5000);
  assert.equal(store.getState().items.length, 1);
  assert.ok(!store.getState().items.some((i) => i.workspaceId === "w1"));
  now += 6000; // past the snooze window
  load(); // a poll recomputes -> the snooze has expired and w1 returns
  assert.equal(store.getState().items.length, 2);
});

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

test("the Decisions view (col-2 push) shows only the panes that want a human", () => {
  const mk = (over: Partial<AttentionItem> & { id: string }): AttentionItem => ({
    source: "cmux", agent: "claude", workspaceId: over.id, title: over.id,
    reason: "waiting", activity: "waiting", body: "", message: "",
    createdAt: "2026-06-20T12:00:00Z", ...over,
  });
  const items: AttentionItem[] = [
    mk({ id: "f", reason: "failed" }),
    mk({ id: "b", reason: "blocked" }),
    mk({ id: "n", needsInput: true }),
    mk({ id: "w" }), // plain waiting -> not a decision
    mk({ id: "k", activity: "working" }), // working -> not a decision
  ];
  const store = new Store();
  store.setAttention(items, false);
  assert.equal(store.getState().view, "queue");
  assert.equal(store.getState().items.length, 5);

  store.cycleView();
  const s = store.getState();
  assert.equal(s.view, "decisions");
  assert.equal(s.items.length, 3); // failed + blocked + needs-input only
  assert.ok(s.items.every((i) => i.reason === "failed" || i.reason === "blocked" || i.needsInput === true));
  assert.ok(!s.items.some((i) => i.activity === "working"));

  store.cycleView(); // back to the full queue
  assert.equal(store.getState().view, "queue");
  assert.equal(store.getState().items.length, 5);
});

test("the LCD number mode toggles between remaining and pace", () => {
  const store = freshStore();
  assert.equal(store.getState().lcdNumberMode, "remaining"); // default
  store.cycleNumberMode();
  assert.equal(store.getState().lcdNumberMode, "pace");
  store.cycleNumberMode();
  assert.equal(store.getState().lcdNumberMode, "remaining");
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

test("event status overrides item activity and drives the age clock", () => {
  const store = freshStore();
  const ws = store.getState().items[0].workspaceId;
  // Mark that workspace as actively working since a known time.
  store.setWorkspaceStatus({ [ws]: { state: "running", since: 1_000_000 } });
  const item = store.getState().items.find((i) => i.workspaceId === ws)!;
  assert.equal(item.activity, "working");
  assert.equal(item.activitySince, 1_000_000);

  // Flip to idle: activity becomes waiting, since advances.
  store.setWorkspaceStatus({ [ws]: { state: "idle", since: 2_000_000 } });
  const idle = store.getState().items.find((i) => i.workspaceId === ws)!;
  assert.equal(idle.activity, "waiting");
  assert.equal(idle.activitySince, 2_000_000);
  assert.ok(!idle.needsInput);

  // cmux "Needs": waiting on you → needsInput flag set.
  store.setWorkspaceStatus({ [ws]: { state: "needs", since: 3_000_000 } });
  const needs = store.getState().items.find((i) => i.workspaceId === ws)!;
  assert.equal(needs.activity, "waiting");
  assert.equal(needs.needsInput, true);

  // Workspaces without event status are left untouched (no activitySince).
  store.setWorkspaceStatus({ "no-such-ws": { state: "running", since: 5 } });
  assert.equal(store.getState().items[0].activitySince, undefined);
});

test("synthetic running panes are listed while working, dropped when not", () => {
  const store = new Store(["codex"]);
  const base = {
    id: "n1", source: "cmux" as const, agent: "claude" as const, workspaceId: "wn", title: "Need you",
    reason: "waiting" as const, activity: "waiting" as const, body: "", message: "",
    createdAt: "2026-06-20T12:00:00Z",
  };
  const run = {
    id: "wr", source: "cmux" as const, agent: "claude" as const, workspaceId: "wr", title: "Running",
    reason: "waiting" as const, activity: "working" as const, body: "", message: "",
    createdAt: "2026-06-20T12:05:00Z", synthetic: true,
  };
  store.setAttention([base, run], false);
  let items = store.getState().items;
  assert.equal(items.length, 2);
  assert.equal(items[items.length - 1].id, "wr"); // running pane sinks to the end

  // Live status says that workspace is idle now → the synthetic pane is dropped.
  store.setWorkspaceStatus({ wr: { state: "idle", since: 1 } });
  items = store.getState().items;
  assert.ok(!items.some((i) => i.id === "wr"));
  assert.equal(items.length, 1);
});

test("clearing a workspace's notifications drops its stale key, keeps a re-ask", () => {
  const store = new Store(["claude"]);
  const mk = (id: string, ws: string, createdAt: string) => ({
    id, source: "cmux" as const, agent: "claude" as const, workspaceId: ws,
    title: id, reason: "blocked" as const, activity: "waiting" as const,
    body: "", message: "", createdAt,
  });
  // Two pending permission keys on different workspaces.
  store.setAttention([
    mk("stale", "wA", "2026-06-20T12:00:00Z"),
    mk("other", "wB", "2026-06-20T12:00:00Z"),
  ], false);
  assert.equal(store.getState().items.length, 2);

  // User clears wA in cmux AFTER that prompt fired → its key vanishes at once.
  store.setClearedNotifications({ wA: Date.parse("2026-06-20T12:01:00Z") });
  let items = store.getState().items;
  assert.ok(!items.some((i) => i.id === "stale"));
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "other"); // an unrelated workspace is untouched

  // The agent asks again (a newer notification) → it survives the prior clear.
  store.setAttention([
    mk("reask", "wA", "2026-06-20T12:05:00Z"),
    mk("other", "wB", "2026-06-20T12:00:00Z"),
  ], false);
  items = store.getState().items;
  assert.ok(items.some((i) => i.id === "reask"));
  assert.equal(items.length, 2);

  // An idempotent re-push of the same clear map is a no-op (no extra emit).
  let emits = 0;
  store.subscribe(() => emits++);
  store.setClearedNotifications({ wA: Date.parse("2026-06-20T12:01:00Z") });
  assert.equal(emits, 0);
});

test("a clear never drops a synthetic running pane (no flicker for a busy agent)", () => {
  // A busy agent that clears its own notifications many times a second must not
  // make its live "working" key flicker on and off. A synthetic running pane is
  // live activity, not a notification, so the clear filter must skip it even
  // though its createdAt (the poll time) predates the clear.
  const store = new Store(["claude"]);
  const running = {
    id: "wX", source: "cmux" as const, agent: "claude" as const, workspaceId: "wX",
    title: "EMNLP", reason: "waiting" as const, activity: "working" as const,
    body: "", message: "", createdAt: "2026-06-20T12:00:00Z", synthetic: true as const,
  };
  store.setAttention([running], false);
  assert.equal(store.getState().items.length, 1);
  // Clear fires AFTER the pane's createdAt — a notification would be dropped, but
  // the working pane stays put.
  store.setClearedNotifications({ wX: Date.parse("2026-06-20T12:05:00Z") });
  const items = store.getState().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "wX");
});

test("a busy command makes a pane 'working' even when the agent is idle", () => {
  const store = freshStore();
  const ws = store.getState().items[0].workspaceId;
  // Agent finished its turn (idle) but a command is crunching (busy).
  store.setAttention(
    store.getState().allItems.map((i) => (i.workspaceId === ws ? { ...i, busy: true } : i)),
    false,
  );
  store.setWorkspaceStatus({ [ws]: { state: "idle", since: 1 } });
  const item = store.getState().items.find((i) => i.workspaceId === ws)!;
  assert.equal(item.activity, "working"); // busy command overrides agent-idle

  // But an explicit "needs you" wins over busy, so the prompt stays visible.
  store.setWorkspaceStatus({ [ws]: { state: "needs", since: 2 } });
  const needs = store.getState().items.find((i) => i.workspaceId === ws)!;
  assert.equal(needs.activity, "waiting");
});

test("a live busy-since beats a stale event since for the age clock", () => {
  const store = freshStore();
  const ws = store.getState().items[0].workspaceId;
  // Agent event froze "idle" 10h ago, but the pane is busy again as of now.
  store.setAttention(
    store.getState().allItems.map((i) =>
      i.workspaceId === ws ? { ...i, busy: true, busySince: 9_999_999 } : i,
    ),
    false,
  );
  store.setWorkspaceStatus({ [ws]: { state: "idle", since: 1 } });
  const item = store.getState().items.find((i) => i.workspaceId === ws)!;
  assert.equal(item.activity, "working");
  assert.equal(item.activitySince, 9_999_999); // the recent busy-since, not the stale idle since
});

test("provider rotation is a no-op with 4 or fewer providers", () => {
  const store = new Store(["codex", "claude", "minimax", "kimi"]);
  store.rotateProviders(1);
  assert.equal(store.getState().providerOffset, 0);
  assert.deepEqual(store.visibleProviderWindow(), ["codex", "claude", "minimax", "kimi"]);
});

test("provider rotation cycles the LCD window when there are more than 4", () => {
  const store = new Store(["a", "b", "c", "d", "e"]);
  // Forward one: window slides and wraps so all four segments stay filled.
  store.rotateProviders(1);
  assert.equal(store.getState().providerOffset, 1);
  assert.deepEqual(store.visibleProviderWindow(), ["b", "c", "d", "e"]);

  // Multi-tick spin accumulates and wraps modulo the provider count.
  store.rotateProviders(2);
  assert.equal(store.getState().providerOffset, 3);
  assert.deepEqual(store.visibleProviderWindow(), ["d", "e", "a", "b"]);

  // Backwards past zero wraps to the end.
  store.rotateProviders(-4);
  assert.equal(store.getState().providerOffset, 4);
  assert.deepEqual(store.visibleProviderWindow(), ["e", "a", "b", "c"]);
});

test("provider rotation resets when discovery drops below 5 providers", () => {
  const store = new Store(["a", "b", "c", "d", "e"]);
  store.rotateProviders(3);
  assert.equal(store.getState().providerOffset, 3);
  // A later poll discovers only three providers: nothing left to rotate.
  store.setUsage(
    ["a", "b", "c"].map((provider) => ({ provider, ok: true })),
    1000,
    false,
  );
  assert.equal(store.getState().providerOffset, 0);
  assert.deepEqual(store.visibleProviderWindow(), ["a", "b", "c", undefined]);
});
