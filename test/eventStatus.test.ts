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
