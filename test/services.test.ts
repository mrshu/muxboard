import { test } from "node:test";
import assert from "node:assert/strict";
import { CmuxClient } from "../src/core/cmux/client.js";
import { CmuxService } from "../src/core/services/cmuxService.js";
import { CodexbarClient } from "../src/core/codexbar/client.js";
import { CodexbarService, isStale } from "../src/core/services/codexbarService.js";
import { Store } from "../src/core/services/store.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const notificationsJson = readFileSync(
  join(here, "fixtures", "cmux-notifications.json"),
  "utf8",
);
const codexUsage = JSON.parse(
  readFileSync(join(here, "fixtures", "codexbar-usage-codex.json"), "utf8"),
) as unknown[];
const claudeUsage = JSON.parse(
  readFileSync(join(here, "fixtures", "codexbar-usage-claude.json"), "utf8"),
) as unknown[];

test("CodexbarService recovers providers individually when aggregate /usage goes empty", async () => {
  const store = new Store([]);
  let aggregateEmpty = false;
  const client = new CodexbarClient({
    fetchJson: async (url) => {
      if (url.endsWith("/usage")) return aggregateEmpty ? [] : [codexUsage[0], claudeUsage[0]];
      if (url.includes("/usage?provider=codex")) return codexUsage;
      if (url.includes("/usage?provider=claude")) return claudeUsage;
      return [];
    },
  });
  const service = new CodexbarService({ client, store, pollMs: 10_000 });

  await service.poll(); // aggregate healthy
  assert.deepEqual(store.getState().providers, ["codex", "claude"]);
  assert.equal(store.getState().codexbarOffline, false);

  aggregateEmpty = true;
  await service.poll(); // aggregate empty, per-provider still live
  assert.equal(store.getState().codexbarOffline, false);
  assert.deepEqual(store.getState().providers, ["codex", "claude"]);
  assert.equal(store.getState().usage["codex"].ok, true);
});

test("CodexbarService retains a provider's last-good on a transient fetch failure", async () => {
  // Mirrors CodexBar's serve crashing on codex activity: codex was live, then
  // its per-provider fetch starts throwing. It must keep showing last-good, not
  // be blanked, while other providers stay live.
  const store = new Store([]);
  let phase = 1;
  const client = new CodexbarClient({
    fetchJson: async (url) => {
      if (url.endsWith("/usage")) {
        return phase === 1 ? [codexUsage[0], claudeUsage[0]] : [claudeUsage[0]];
      }
      if (url.includes("/usage?provider=codex")) throw new Error("ECONNREFUSED");
      if (url.includes("/usage?provider=claude")) return claudeUsage;
      return [];
    },
  });
  const service = new CodexbarService({ client, store, pollMs: 10_000 });

  await service.poll(); // phase 1: aggregate carries codex + claude
  assert.equal(store.getState().usage["codex"].ok, true);
  const codexWeekly = store.getState().usage["codex"].weekly?.usedPercent;

  phase = 2; // aggregate drops codex; codex's per-provider fetch throws (transient)
  await service.poll();
  assert.equal(store.getState().codexbarOffline, false);
  assert.equal(store.getState().usage["codex"].ok, true); // last-good retained
  assert.equal(store.getState().usage["codex"].weekly?.usedPercent, codexWeekly);
  assert.ok(store.getState().providers.includes("codex")); // stays on the strip
});

test("CodexbarService surfaces semantic provider errors rather than masking them as offline", async () => {
  // Every provider returns a real error (server up, e.g. tokens expired). This
  // is NOT an outage: each segment must show its own error, not stale numbers
  // under a generic offline banner.
  const errEntry = (p: string) => ({ provider: p, error: { message: "invalid or expired token" } });
  const store = new Store([]);
  const client = new CodexbarClient({
    fetchJson: async (url) => {
      if (url.endsWith("/usage")) return [errEntry("codex"), errEntry("claude")];
      return [];
    },
  });
  await new CodexbarService({ client, store, pollMs: 10_000 }).poll();
  const s = store.getState();
  assert.equal(s.codexbarOffline, false); // server answered; not an outage
  assert.deepEqual(s.providers, ["codex", "claude"]);
  assert.equal(s.usage["codex"].ok, false);
  assert.match(s.usage["codex"].error ?? "", /expired/);
});

test("CodexbarService ages a removed provider out of discovery (no phantom segment)", async () => {
  // Provider present at first, then gone from the aggregate and returning a real
  // error individually (disabled in CodexBar). It must not linger forever.
  const store = new Store([]);
  let phase = 1;
  const client = new CodexbarClient({
    fetchJson: async (url) => {
      if (url.endsWith("/usage")) {
        return phase === 1 ? [codexUsage[0], claudeUsage[0]] : [claudeUsage[0]];
      }
      if (url.includes("/usage?provider=claude")) return claudeUsage;
      // codex is gone: individual fetch returns a real (semantic) error.
      if (url.includes("/usage?provider=codex"))
        return [{ provider: "codex", error: { message: "provider disabled" } }];
      return [];
    },
  });
  const svc = new CodexbarService({ client, store, pollMs: 10_000 });
  await svc.poll(); // phase 1: codex discovered
  assert.ok(store.getState().providers.includes("codex"));
  phase = 2; // codex dropped from aggregate + errors individually
  await svc.poll(); // still re-fetched once (was in lastGood), shown as error, aged out
  await svc.poll(); // no longer in lastGood or aggregate → gone from the strip
  assert.equal(store.getState().providers.includes("codex"), false);
  assert.deepEqual(store.getState().providers, ["claude"]);
});

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

test("CmuxService surfaces a running, custom-titled, notification-less pane from the event stream", async () => {
  const store = new Store();
  // The live event stream (set_status) is authoritative and marks the workspace
  // running; cmux's workspace-list title has no spinner because it is custom.
  store.setWorkspaceStatus({ "w-bug": { state: "running", since: 0 } });
  const client = new CmuxClient({
    runner: async (_bin, args) => {
      if (args[0] === "list-notifications") return { stdout: "[]", stderr: "" };
      if (args.includes("top")) return { stdout: "{}", stderr: "" };
      if (args.includes("workspace"))
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "w-bug",
                title: "Bug Review Report",
                has_custom_title: true,
                custom_title: "Bug Review Report",
              },
            ],
          }),
          stderr: "",
        };
      return { stdout: "", stderr: "" };
    },
  });
  const service = new CmuxService({ client, store, pollMs: 10_000 });

  await service.poll();
  const items = store.getState().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].workspaceId, "w-bug");
  assert.equal(items[0].activity, "working");
  assert.equal(items[0].synthetic, true);
});

test("CmuxService surfaces a custom-titled agent working from its surface spinner, with no hooks", async () => {
  const store = new Store();
  // No event-stream status at all (the hand-launched-claude / GC'd-shim case),
  // and the workspace-list title is custom so it carries no spinner glyph. The
  // braille spinner survives on the pane's surface title in `cmux top`, which is
  // the only "working" signal left — muxboard must still surface the pane.
  const top = JSON.stringify({
    coding_agents: [{ id: "claude", resources: { pids: [100] } }],
    windows: [
      {
        workspaces: [
          { id: "w-surf", panes: [{ surfaces: [{ kind: "surface", root_pids: [100], title: "⠂ View for refs" }] }] },
        ],
      },
    ],
  });
  const client = new CmuxClient({
    runner: async (_bin, args) => {
      if (args[0] === "list-notifications") return { stdout: "[]", stderr: "" };
      if (args.includes("top")) return { stdout: top, stderr: "" };
      if (args.includes("workspace"))
        return {
          stdout: JSON.stringify({
            workspaces: [{ ref: "w-surf", title: "RCJ Scoreboard", has_custom_title: true, custom_title: "RCJ Scoreboard" }],
          }),
          stderr: "",
        };
      return { stdout: "", stderr: "" };
    },
  });
  const service = new CmuxService({ client, store, pollMs: 10_000 });

  await service.poll();
  const items = store.getState().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].workspaceId, "w-surf");
  assert.equal(items[0].agent, "claude");
  assert.equal(items[0].activity, "working");
  assert.equal(items[0].synthetic, true);
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
