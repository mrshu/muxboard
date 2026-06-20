import { test } from "node:test";
import assert from "node:assert/strict";
import { CmuxBridgeClient } from "../src/core/cmux/bridgeClient.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const notifications = JSON.parse(
  readFileSync(join(here, "fixtures", "cmux-notifications.json"), "utf8"),
);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test("CmuxBridgeClient.listAttention fetches and normalizes from the bridge", async () => {
  const calls: string[] = [];
  const client = new CmuxBridgeClient({
    baseUrl: "http://127.0.0.1:17779",
    http: async (url) => {
      calls.push(url);
      return jsonResponse(notifications);
    },
  });
  const items = await client.listAttention();
  assert.equal(items.length, 5);
  assert.equal(calls[0], "http://127.0.0.1:17779/notifications");
});

test("CmuxBridgeClient.openNotification POSTs the id", async () => {
  const calls: { url: string; method?: string }[] = [];
  const client = new CmuxBridgeClient({
    http: async (url, init) => {
      calls.push({ url, method: init?.method });
      return jsonResponse({ ok: true });
    },
  });
  await client.openNotification("ABC-123");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/open\?id=ABC-123$/);
});

test("CmuxBridgeClient surfaces a non-ok bridge response as an error", async () => {
  const client = new CmuxBridgeClient({
    http: async () => jsonResponse({ error: "cmux call failed" }, false, 502),
  });
  await assert.rejects(() => client.listAttention(), /bridge HTTP 502/);
});

test("CmuxBridgeClient.health is false when the bridge is unreachable", async () => {
  const client = new CmuxBridgeClient({
    http: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(await client.health(), false);
});
