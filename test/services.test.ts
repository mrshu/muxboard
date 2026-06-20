import { test } from "node:test";
import assert from "node:assert/strict";
import { CmuxClient } from "../src/core/cmux/client.js";
import { CmuxService } from "../src/core/services/cmuxService.js";
import { isStale } from "../src/core/services/codexbarService.js";
import { Store } from "../src/core/services/store.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const notificationsJson = readFileSync(
  join(here, "fixtures", "cmux-notifications.json"),
  "utf8",
);

test("CmuxClient.listAttention parses an injected runner's stdout", async () => {
  const client = new CmuxClient({
    runner: async (_bin, args) => {
      assert.deepEqual(args, ["list-notifications", "--json"]);
      return { stdout: notificationsJson, stderr: "" };
    },
  });
  const items = await client.listAttention();
  assert.equal(items.length, 5);
});

test("CmuxClient.openNotification calls the blessed jump primitive", async () => {
  const calls: string[][] = [];
  const client = new CmuxClient({
    runner: async (_bin, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  });
  await client.openNotification("ABC-123");
  assert.deepEqual(calls[0], ["open-notification", "--id", "ABC-123"]);
});

test("CmuxService keeps last-good items and flags offline after 2 failures", async () => {
  const store = new Store(["codex"]);
  let mode: "ok" | "fail" = "ok";
  const client = new CmuxClient({
    runner: async () => {
      if (mode === "fail") throw new Error("cmux not found");
      return { stdout: notificationsJson, stderr: "" };
    },
  });
  const service = new CmuxService({ client, store, pollMs: 10_000 });

  await service.poll();
  assert.equal(store.getState().items.length, 5);
  assert.equal(store.getState().cmuxOffline, false);

  mode = "fail";
  await service.poll(); // 1st failure: still online, items retained
  assert.equal(store.getState().cmuxOffline, false);
  assert.equal(store.getState().items.length, 5);

  await service.poll(); // 2nd failure: offline
  assert.equal(store.getState().cmuxOffline, true);
  assert.equal(store.getState().items.length, 5); // last good retained
});

test("isStale flags data older than the threshold", () => {
  const now = Date.parse("2026-06-20T12:10:00Z");
  assert.equal(isStale(null, now, 90_000), true);
  assert.equal(isStale(now - 30_000, now, 90_000), false);
  assert.equal(isStale(now - 120_000, now, 90_000), true);
});
