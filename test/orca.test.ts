import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNotifications } from "../src/core/cmux/normalize.js";

test("cmux notifications are stamped with source 'cmux'", () => {
  const items = normalizeNotifications([
    { id: "n1", workspace_id: "w1", title: "Claude Code", body: "done", created_at: "2026-06-23T10:00:00Z" },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "cmux");
});
