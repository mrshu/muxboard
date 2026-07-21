import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttentionItem } from "../src/core/types.js";

/**
 * The actions are SDK-coupled, so these tests drive them with fake Key/Dial
 * action objects — enough to cover the render/debounce/retry logic without a
 * Stream Deck connection.
 *
 * The @elgato/streamdeck SDK reads manifest.json from process.cwd() at import
 * time (its module-level SDKVersion check), and the plugin's manifest lives in
 * the .sdPlugin dir — so chdir there BEFORE importing the action modules.
 * `node --test` isolates each file in its own process, so the chdir can't
 * affect the rest of the suite.
 */
const here = dirname(fileURLToPath(import.meta.url));
process.chdir(join(here, "..", "com.mrshu.muxboard.sdPlugin"));

const { AttentionKeyAction } = await import("../src/actions/attentionKey.js");
const { DialStripAction } = await import("../src/actions/dialStrip.js");
const { Store } = await import("../src/core/services/store.js");

const tick = () => new Promise((r) => setTimeout(r, 20));

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeRuntime(store: InstanceType<typeof Store>): any {
  return {
    config: { codexbarBaseUrl: "http://127.0.0.1:1" },
    store,
    logger: { info() {}, warn() {}, error() {} },
    codexbarService: { staleThresholdMs: 90_000 },
    backends: {
      cmux: { async focus() {}, async dismiss() {} },
      orca: { async focus() {}, async dismiss() {} },
    },
  };
}

function makeItem(title: string): AttentionItem {
  return {
    id: `n-${title}`, source: "cmux", agent: "claude", workspaceId: "w1",
    title, reason: "waiting", activity: "waiting",
    body: "", message: "", createdAt: new Date().toISOString(),
  };
}

/** A fake Stream Deck key whose setImage can be scripted to fail. */
function fakeKey(onSetImage: () => Promise<void>): any {
  return {
    id: "k1",
    isKey: () => true,
    coordinates: { column: 0, row: 0 },
    setImage: onSetImage,
    showOk: async () => {},
    showAlert: async () => {},
  };
}

test("key: a failed setImage is retried on the next store emit (not debounced away)", async () => {
  const store = new Store();
  const action = new AttentionKeyAction(makeRuntime(store));
  let calls = 0;
  let fail = true;
  const key = fakeKey(async () => {
    calls++;
    if (fail) {
      fail = false;
      throw new Error("websocket hiccup");
    }
  });
  (action as any).onWillAppear({ action: key });
  await tick();
  assert.equal(calls, 1); // the failed attempt

  // An unrelated emit with IDENTICAL key content must now retry the write
  // (previously the debounce cache was already updated, so it never retried).
  store.setUsage([], Date.now(), true);
  await tick();
  assert.equal(calls, 2);
});

test("key: a successful setImage is still debounced (no redundant re-sends)", async () => {
  const store = new Store();
  const action = new AttentionKeyAction(makeRuntime(store));
  let calls = 0;
  const key = fakeKey(async () => {
    calls++;
  });
  (action as any).onWillAppear({ action: key });
  await tick();
  store.setUsage([], Date.now(), true); // identical key content
  await tick();
  assert.equal(calls, 1);
});

test("key: an earlier failure never clobbers a newer render's cache entry", async () => {
  const store = new Store();
  const action = new AttentionKeyAction(makeRuntime(store));
  const pending: Array<() => void> = [];
  let calls = 0;
  const key = fakeKey(
    () =>
      new Promise<void>((resolve, reject) => {
        calls++;
        // First write rejects late (after the second render), second succeeds.
        pending.push(calls === 1 ? () => reject(new Error("late hiccup")) : resolve);
      }),
  );
  (action as any).onWillAppear({ action: key });
  store.setAttention([makeItem("one")], false, "cmux");
  await tick();
  assert.equal(calls, 2); // empty → "one" (render #2 happened while #1 in flight)

  // The late rejection of render #1 must NOT un-cache render #2's svg.
  pending[0]!();
  pending[1]!();
  await tick();
  store.setUsage([], Date.now(), true); // identical key content
  await tick();
  assert.equal(calls, 2, "render #2's cache entry must survive render #1's failure");
});

test("dial: a failed setFeedback is retried on the next store emit", async () => {
  const store = new Store();
  const action = new DialStripAction(makeRuntime(store));
  let calls = 0;
  let fail = true;
  const dial: any = {
    id: "d1",
    isDial: () => true,
    coordinates: { column: 0, row: 0 },
    setFeedbackLayout: async () => {},
    setFeedback: async () => {
      calls++;
      if (fail) {
        fail = false;
        throw new Error("websocket hiccup");
      }
    },
    showOk: async () => {},
    showAlert: async () => {},
  };
  (action as any).onWillAppear({ action: dial });
  await tick();
  assert.equal(calls, 1);

  store.setUsage([], Date.now(), true); // identical segment content
  await tick();
  assert.equal(calls, 2, "failed setFeedback must be retried on the next emit");
});
