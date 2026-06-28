import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceStatusTracker, hookToState } from "../src/core/cmux/eventStatus.js";

const ev = (name: string, workspace_id: string, occurred_at: string, hook = name) => ({
  name: `agent.hook.${name}`,
  occurred_at,
  payload: { hook_event_name: hook, workspace_id },
});

test("hookToState maps the agent lifecycle to three states", () => {
  assert.equal(hookToState("UserPromptSubmit"), "running");
  assert.equal(hookToState("PreToolUse"), "running");
  assert.equal(hookToState("Notification"), "needs");
  assert.equal(hookToState("AskUserQuestion"), "needs");
  assert.equal(hookToState("Stop"), "idle");
  assert.equal(hookToState("SessionEnd"), "idle");
  assert.equal(hookToState("WhoKnows"), null);
});

test("tracker records state + since from the transition's occurred_at", () => {
  const t = new WorkspaceStatusTracker();
  assert.equal(t.ingest(ev("UserPromptSubmit", "w1", "2026-06-20T12:00:00Z")), true);
  const s = t.snapshot();
  assert.equal(s.w1.state, "running");
  assert.equal(s.w1.since, Date.parse("2026-06-20T12:00:00Z"));
});

test("since stays put while the state is unchanged (working burst start)", () => {
  const t = new WorkspaceStatusTracker();
  t.ingest(ev("UserPromptSubmit", "w1", "2026-06-20T12:00:00Z"));
  // More working events arrive; state stays running, since must NOT advance.
  assert.equal(t.ingest(ev("PreToolUse", "w1", "2026-06-20T12:01:30Z")), false);
  assert.equal(t.ingest(ev("PreToolUse", "w1", "2026-06-20T12:02:00Z")), false);
  assert.equal(t.snapshot().w1.since, Date.parse("2026-06-20T12:00:00Z"));
});

test("since advances on a real transition (working -> idle)", () => {
  const t = new WorkspaceStatusTracker();
  t.ingest(ev("PreToolUse", "w1", "2026-06-20T12:00:00Z"));
  assert.equal(t.ingest(ev("Stop", "w1", "2026-06-20T12:05:00Z")), true);
  const s = t.snapshot();
  assert.equal(s.w1.state, "idle");
  assert.equal(s.w1.since, Date.parse("2026-06-20T12:05:00Z"));
});

test("tracks workspaces independently", () => {
  const t = new WorkspaceStatusTracker();
  t.ingest(ev("PreToolUse", "w1", "2026-06-20T12:00:00Z"));
  t.ingest(ev("Notification", "w2", "2026-06-20T12:00:10Z"));
  const s = t.snapshot();
  assert.equal(s.w1.state, "running");
  assert.equal(s.w2.state, "needs");
});

test("ignores non-agent events, unknown hooks, and rows without a workspace", () => {
  const t = new WorkspaceStatusTracker();
  assert.equal(t.ingest({ name: "sidebar.metadata.updated", payload: {} }), false);
  assert.equal(t.ingest(ev("PreToolUse", "", "2026-06-20T12:00:00Z")), false);
  assert.equal(t.ingest(ev("Heartbeat", "w1", "2026-06-20T12:00:00Z")), false);
  assert.deepEqual(t.snapshot(), {});
});

test("falls back to injected clock when occurred_at is missing/unparseable", () => {
  const t = new WorkspaceStatusTracker(() => 999);
  t.ingest({ name: "agent.hook.Stop", payload: { hook_event_name: "Stop", workspace_id: "w1" } });
  assert.equal(t.snapshot().w1.since, 999);
});

const setStatus = (value: string, ws: string, occurred_at: string) => ({
  name: "sidebar.metadata.updated",
  occurred_at,
  payload: { command: "set_status", args: `claude_code ${value} --icon=bolt --tab=${ws} --pid=5` },
});

test("ingests cmux's own set_status verdict (Running/Idle/Needs)", () => {
  const t = new WorkspaceStatusTracker();
  assert.equal(t.ingest(setStatus("Running", "w1", "2026-06-20T12:00:00Z")), true);
  assert.equal(t.snapshot().w1.state, "running");
  assert.equal(t.snapshot().w1.since, Date.parse("2026-06-20T12:00:00Z"));
  // Multi-word label "Needs input" maps to needs.
  t.ingest(setStatus("Needs input", "w1", "2026-06-20T12:01:00Z"));
  assert.equal(t.snapshot().w1.state, "needs");
});

test("set_status is authoritative: hook events can't override it", () => {
  const t = new WorkspaceStatusTracker();
  t.ingest(setStatus("Idle", "w1", "2026-06-20T12:00:00Z"));
  // A stale/raw hook says running, but cmux's verdict (idle) must win.
  assert.equal(
    t.ingest({
      name: "agent.hook.PreToolUse",
      occurred_at: "2026-06-20T12:00:30Z",
      payload: { hook_event_name: "PreToolUse", workspace_id: "w1" },
    }),
    false,
  );
  assert.equal(t.snapshot().w1.state, "idle");
});

test("a terminal Stop hook clears a stale 'Running' verdict cmux never closed", () => {
  // cmux reliably emits the Running set_status but often omits the matching
  // Idle one, so a finished agent would otherwise stay "working" forever.
  const t = new WorkspaceStatusTracker();
  t.ingest(setStatus("Running", "w1", "2026-06-20T12:00:00Z"));
  assert.equal(
    t.ingest({
      name: "agent.hook.Stop",
      occurred_at: "2026-06-20T12:30:00Z",
      payload: { hook_event_name: "Stop", workspace_id: "w1" },
    }),
    true,
  );
  const s = t.snapshot();
  assert.equal(s.w1.state, "idle");
  assert.equal(s.w1.since, Date.parse("2026-06-20T12:30:00Z"));
});

test("a Stop hook older than the running burst can't clear a live verdict", () => {
  // Guards against a replayed/out-of-order Stop predating the run.
  const t = new WorkspaceStatusTracker();
  t.ingest(setStatus("Running", "w1", "2026-06-20T12:00:00Z"));
  assert.equal(
    t.ingest({
      name: "agent.hook.Stop",
      occurred_at: "2026-06-20T11:59:00Z",
      payload: { hook_event_name: "Stop", workspace_id: "w1" },
    }),
    false,
  );
  assert.equal(t.snapshot().w1.state, "running");
});

test("hooks still drive workspaces cmux publishes no set_status for", () => {
  const t = new WorkspaceStatusTracker();
  t.ingest({
    name: "agent.hook.PreToolUse",
    occurred_at: "2026-06-20T12:00:00Z",
    payload: { hook_event_name: "PreToolUse", workspace_id: "w9" },
  });
  assert.equal(t.snapshot().w9.state, "running");
});

const clearReq = (ws: string, occurred_at: string) => ({
  name: "notification.clear_requested",
  occurred_at,
  // cmux carries the target in args (--tab=), with top-level workspace_id null.
  payload: { command: "clear_notifications", args: `--tab=${ws}` },
  workspace_id: null,
});

test("tracks the latest notification-clear time per workspace", () => {
  const t = new WorkspaceStatusTracker();
  assert.equal(t.ingest(clearReq("w1", "2026-06-20T12:00:00Z")), true);
  assert.equal(t.clearedSnapshot().w1, Date.parse("2026-06-20T12:00:00Z"));
  // An older clear doesn't move it back; a newer one advances it.
  assert.equal(t.ingest(clearReq("w1", "2026-06-20T11:00:00Z")), false);
  assert.equal(t.ingest(clearReq("w1", "2026-06-20T13:00:00Z")), true);
  assert.equal(t.clearedSnapshot().w1, Date.parse("2026-06-20T13:00:00Z"));
  // Clears live in their own map; they never pollute the status snapshot.
  assert.deepEqual(t.snapshot(), {});
});

test("a clear_requested without a --tab target is ignored", () => {
  const t = new WorkspaceStatusTracker();
  assert.equal(
    t.ingest({
      name: "notification.clear_requested",
      occurred_at: "2026-06-20T12:00:00Z",
      payload: { command: "clear_notifications", args: "" },
    }),
    false,
  );
  assert.deepEqual(t.clearedSnapshot(), {});
});
