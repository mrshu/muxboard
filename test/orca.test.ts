import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, DEFAULT_CONFIG } from "../src/config.js";
import { normalizeNotifications } from "../src/core/cmux/normalize.js";
import { Store } from "../src/core/services/store.js";
import type { AttentionItem } from "../src/core/types.js";
import { OrcaService } from "../src/core/services/orcaService.js";
import { sourceGlyphSvg } from "../src/core/render/sourceIcons.js";
import { renderKey } from "../src/core/render/keyRender.js";

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

test("OrcaService pushes orca items and flips offline after 2 failures", async () => {
  const store = new Store();
  let mode: "ok" | "fail" = "ok";
  const client = {
    async listAttention() {
      if (mode === "fail") throw new Error("boom");
      return [item({ id: "o1", source: "orca" })];
    },
  } as unknown as OrcaClient;
  const svc = new OrcaService({ client, store, pollMs: 10_000 });

  await svc.poll();
  assert.equal(store.getState().items.some((i) => i.id === "o1"), true);
  assert.equal(store.getState().orcaOffline, false);

  mode = "fail";
  await svc.poll();
  assert.equal(store.getState().orcaOffline, false); // one failure rides out
  await svc.poll();
  assert.equal(store.getState().orcaOffline, true); // two consecutive -> offline
  assert.equal(store.getState().items.some((i) => i.id === "o1"), true); // last good kept
});

test("cmux live status overlay never mutates an orca item sharing a workspaceId", () => {
  const store = new Store();
  store.setAttention([item({ id: "c", workspaceId: "shared", source: "cmux", activity: "waiting" })], false, "cmux");
  store.setAttention([item({ id: "o", workspaceId: "shared", source: "orca", activity: "waiting" })], false, "orca");
  store.setWorkspaceStatus({ shared: { state: "running", since: 0 } });
  const byId = Object.fromEntries(store.getState().items.map((i) => [i.source, i]));
  assert.equal(byId.cmux.activity, "working"); // cmux item picks up the overlay
  assert.equal(byId.orca.activity, "waiting"); // orca item is untouched
});

test("same workspaceId in two sources is NOT deduped together", () => {
  const store = new Store();
  store.setAttention([item({ id: "x", workspaceId: "repo", source: "cmux" })], false, "cmux");
  store.setAttention([item({ id: "x", workspaceId: "repo", source: "orca" })], false, "orca");
  assert.equal(store.getState().items.length, 2);
});


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

test("orca picks the most-recent done agent regardless of array order", () => {
  const recent = { state: "done", agentType: "claude", interrupted: true, stateStartedAt: 1782000200000 };
  const older = { state: "done", agentType: "claude", interrupted: false, stateStartedAt: 1782000100000 };
  const a = normalizeWorktrees([wt({ status: "done", agents: [older, recent] })], NOW);
  const b = normalizeWorktrees([wt({ status: "done", agents: [recent, older] })], NOW);
  assert.equal(a[0].reason, "failed"); // most recent is interrupted, both orders
  assert.equal(b[0].reason, "failed");
});

test("orca createdAt falls back to updatedAt then lastOutputAt", () => {
  const items = normalizeWorktrees([wt({
    status: "done", lastOutputAt: 1782000000000,
    agents: [{ state: "done", agentType: "claude", updatedAt: 1782000050000 }], // no stateStartedAt
  })], NOW);
  assert.equal(items[0].createdAt, new Date(1782000050000).toISOString());
});

test("orca active/inactive worktrees are not surfaced; unknown agent type maps to unknown", () => {
  assert.equal(normalizeWorktrees([wt({ status: "active" }), wt({ status: "inactive" })], NOW).length, 0);
  const g = normalizeWorktrees([wt({ status: "done", agents: [{ state: "done", agentType: "gemini" }] })], NOW);
  assert.equal(g[0].agent, "unknown");
});


function fakeRunner(map: Record<string, string>) {
  return async (_bin: string, args: string[]) => {
    const key = args.find((a) => !a.startsWith("--")) ?? "";
    const sub = args.includes("ps") ? "ps" : args.includes("list") ? "list" : args.includes("focus") ? "focus" : args.includes("status") ? "status" : key;
    return { stdout: map[sub] ?? "{}", stderr: "" };
  };
}

test("OrcaClient.listAttention parses ps JSON to items", async () => {
  const ps = JSON.stringify({ ok: true, result: { worktrees: [
    { worktreeId: "r::/p", repo: "r", displayName: "feat", status: "permission",
      agents: [{ state: "waiting", agentType: "claude", lastAssistantMessage: "ok?" }] },
  ] } });
  const client = new OrcaClient({ runner: fakeRunner({ ps }), now: () => 0 });
  const items = await client.listAttention();
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "orca");
  assert.equal(items[0].reason, "blocked");
});

test("OrcaClient.reachable reflects status JSON", async () => {
  const up = JSON.stringify({ ok: true, result: { app: { running: true }, runtime: { reachable: true } } });
  const down = JSON.stringify({ ok: false, result: { runtime: { reachable: false } } });
  assert.equal(await new OrcaClient({ runner: fakeRunner({ status: up }) }).reachable(), true);
  assert.equal(await new OrcaClient({ runner: fakeRunner({ status: down }) }).reachable(), false);
});

test("OrcaClient.focus picks the most recent terminal handle", async () => {
  const calls: string[][] = [];
  const runner = async (_bin: string, args: string[]) => {
    calls.push(args);
    if (args.includes("list")) {
      return { stdout: JSON.stringify({ ok: true, result: { terminals: [
        { handle: "term_old", worktreeId: "r::/p", lastOutputAt: 100 },
        { handle: "term_new", worktreeId: "r::/p", lastOutputAt: 200 },
        { handle: "term_other", worktreeId: "other::/q", lastOutputAt: 999 },
      ] } }), stderr: "" };
    }
    return { stdout: JSON.stringify({ ok: true }), stderr: "" };
  };
  const client = new OrcaClient({ runner });
  await client.focus({ id: "r::/p", source: "orca", agent: "claude", workspaceId: "r::/p", title: "t", reason: "blocked", activity: "waiting", body: "", message: "", createdAt: "2026-06-23T12:00:00Z" });
  const listCall = calls.find((a) => a.includes("list"));
  assert.ok(listCall);
  assert.ok(listCall.includes("--worktree") && listCall.includes("id:r::/p")); // scoped server-side
  const focusCall = calls.find((a) => a.includes("focus"));
  assert.ok(focusCall);
  assert.ok(focusCall.includes("term_new"));
});

test("OrcaClient.listAttention throws on an ok:false envelope (so the poller keeps last-good)", async () => {
  const ps = JSON.stringify({ ok: false, error: { code: "runtime_unreachable", message: "down" } });
  const client = new OrcaClient({ runner: fakeRunner({ ps }) });
  await assert.rejects(() => client.listAttention(), /worktree ps failed/);
});

test("OrcaClient.listAttention throws when worktrees is missing", async () => {
  const ps = JSON.stringify({ ok: true, result: {} });
  const client = new OrcaClient({ runner: fakeRunner({ ps }) });
  await assert.rejects(() => client.listAttention(), /not an array/);
});

test("OrcaClient.focus throws when terminal focus returns ok:false", async () => {
  const runner = async (_bin: string, args: string[]) => {
    if (args.includes("list")) {
      return { stdout: JSON.stringify({ ok: true, result: { terminals: [
        { handle: "term_x", worktreeId: "r::/p", lastOutputAt: 1 },
      ] } }), stderr: "" };
    }
    return { stdout: JSON.stringify({ ok: false, error: { code: "no_tab", message: "gone" } }), stderr: "" };
  };
  const client = new OrcaClient({ runner });
  await assert.rejects(
    () => client.focus({ id: "r::/p", source: "orca", agent: "claude", workspaceId: "r::/p", title: "t", reason: "blocked", activity: "waiting", body: "", message: "", createdAt: "2026-06-23T12:00:00Z" }),
    /terminal focus failed/,
  );
});


test("orca backend dismiss focuses the worktree (clears unread)", async () => {
  const calls: AttentionItem[] = [];
  const orca = { async focus(it: AttentionItem) { calls.push(it); } } as unknown as import("../src/core/orca/client.js").OrcaClient;
  const backend = makeOrcaBackend(orca, { info() {}, warn() {}, error() {} });
  const it = item({ id: "o1", source: "orca" });
  await backend.dismiss(it); // long-press on an Orca key
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "o1");
});

test("sourceGlyphSvg emits a tinted group for known sources", () => {
  const orca = sourceGlyphSvg("orca", 110, 120, 22, "#8b919c");
  assert.match(orca, /<g transform=/);
  assert.match(orca, /#8b919c/);
  assert.doesNotMatch(orca, /currentColor/); // color substituted in
});

test("renderKey includes the source badge group", () => {
  const svg = renderKey(item({ id: "o1", source: "orca", title: "feat" }), { nowMs: Date.parse("2026-06-23T12:00:10Z"), slotNumber: 1 });
  assert.match(svg, /<g transform=/); // the badge group is present
});

test("resolveConfig defaults and coerces Orca knobs", () => {
  assert.equal(DEFAULT_CONFIG.enableOrca, "auto");
  assert.equal(DEFAULT_CONFIG.orcaBin, "orca");
  const r = resolveConfig({ enableOrca: true, orcaBin: " /usr/local/bin/orca ", orcaPollMs: 1 });
  assert.equal(r.enableOrca, true);
  assert.equal(r.orcaBin, "/usr/local/bin/orca");
  assert.equal(r.orcaPollMs, 500); // clamped to the 500 floor
  assert.equal(resolveConfig({ enableOrca: "nonsense" as unknown as "auto" }).enableOrca, "auto");
});
