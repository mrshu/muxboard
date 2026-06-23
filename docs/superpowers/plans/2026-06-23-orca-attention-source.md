# Orca Attention Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Orca (onorca.dev) as a second, coexisting attention source whose worktrees merge into muxboard's existing 8-key queue, each key tagged and badged by origin.

**Architecture:** A new `OrcaService`/`OrcaClient` mirrors the cmux poller, polling `orca worktree ps --json` and normalizing to `AttentionItem[]` tagged `source: "orca"`. The store changes from a single `allItems` array to per-source slices merged on `recompute()`; the sort/triage/slot pipeline is unchanged. Focus/dismiss dispatch by `item.source` through a small per-source backend. Orca is auto-detected via `orca status` and rendered with a logo-derived source badge.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥ 20, `node:test` + `node:assert/strict`, rollup, `@elgato/streamdeck`. Tests run via `npm test` (`node --import tsx --test "test/**/*.test.ts"`).

## Global Constraints

- ESM with explicit `.js` extensions on relative imports (e.g. `"../types.js"`), even from `.ts` files.
- `src/core/**` stays dependency-free of `@elgato/streamdeck` and (for `core/orca/normalize.ts`, `core/types.ts`) of Node built-ins, so it is unit-testable and headless-renderable.
- `AgentKind` is exactly `"claude" | "codex" | "pi" | "unknown"`; Orca agent types outside this set map to `"unknown"`.
- Every external CLI call is best-effort: failures throw and are caught by the poll service (keep last good state) or the key handler (`showAlert`), never crash the loop. 10s exec ceiling.
- The `orca` CLI exit code is ALWAYS 0; parse the JSON `ok` field, never `$?`.
- No AI attribution anywhere. Conventional Commits with a body (motivation + change).
- Do not touch `src/core/cmux/*` parsing internals, `CmuxClient`, `CmuxEventsService`, the CodexBar/LCD layer, or the triage/slot ranking — only the shared seams named below.
- Tests live flat in `test/` (e.g. `test/orca.test.ts`), matching the existing convention.

---

### Task 1: `AttentionSource` type, `source` field, per-source offline state

Adds the source tag to the domain model and widens the offline state to two sources. cmux normalizers stamp `source: "cmux"`. After this task the project still typechecks and all existing tests pass.

**Files:**
- Modify: `src/core/types.ts` (AttentionItem, AppState)
- Modify: `src/core/cmux/normalize.ts` (`normalizeNotification` return, `buildRunningItems` push)
- Modify: `src/core/services/store.ts` (constructor init of new AppState fields)
- Test: `test/orca.test.ts` (new file)

**Interfaces:**
- Produces: `AttentionSource = "cmux" | "orca"`; `AttentionItem.source: AttentionSource` (required); `AppState.cmuxOffline` (kept) plus `AppState.orcaOffline: boolean` and `AppState.orcaActive: boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/orca.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "stamped with source"`
Expected: FAIL — `items[0].source` is `undefined` (and/or a TS error that `source` is missing).

- [ ] **Step 3: Add the type**

In `src/core/types.ts`, after the `AgentKind` line (`export type AgentKind = ...`), add:

```ts
/** Which backend an attention item originates from. */
export type AttentionSource = "cmux" | "orca";
```

In the `AttentionItem` interface, add a required field directly under `id`:

```ts
  /** The backend this item came from (cmux notification vs Orca worktree). */
  source: AttentionSource;
```

In the `AppState` interface, replace the single `cmuxOffline` doc-line block with:

```ts
  /** True when the cmux feed is currently unavailable. */
  cmuxOffline: boolean;
  /** True when the Orca feed is currently unavailable. */
  orcaOffline: boolean;
  /** True once the Orca poller has been started (auto-detected reachable). */
  orcaActive: boolean;
```

- [ ] **Step 4: Stamp `source` in the cmux normalizers**

In `src/core/cmux/normalize.ts`, in the object returned by `normalizeNotification`, add `source: "cmux",` as the second property (right after `id,`):

```ts
  return {
    id,
    source: "cmux",
    agent: processAgent && processAgent !== "unknown" ? processAgent : detectAgent(`${title} ${tabTitle}`, aliases),
```

In `buildRunningItems`, add `source: "cmux",` right after `id: workspaceId,`:

```ts
    out.push({
      id: workspaceId, // no notification; the workspace id is the focus key
      source: "cmux",
      agent: agents.get(workspaceId) ?? "unknown",
```

- [ ] **Step 5: Initialize the new AppState fields**

In `src/core/services/store.ts`, in the constructor's `this.state = { ... }`, replace the `cmuxOffline: false,` line with:

```ts
      cmuxOffline: false,
      orcaOffline: false,
      orcaActive: false,
```

- [ ] **Step 6: Run the new test and the full suite**

Run: `npm test`
Expected: PASS (the new test passes; existing tests still pass — `AttentionItem` literals built inside tests will error if any omit `source`; if a test helper builds bare items, add `source: "cmux"` to it).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/cmux/normalize.ts src/core/services/store.ts test/orca.test.ts
git commit -F - <<'EOF'
feat(types): add AttentionSource and per-source offline state

Muxboard modeled a single cmux source; coexisting with Orca needs each
item tagged by origin and an offline flag per source. Add the source
field and the Orca offline/active flags, stamping existing cmux items.

- Add `AttentionSource` and required `AttentionItem.source`
- Stamp `source:"cmux"` in normalizeNotification and buildRunningItems
- Add `orcaOffline`/`orcaActive` to AppState, seeded false
EOF
```

---

### Task 2: Store per-source merge + cross-source dedup

Splits the store's single queue into per-source slices merged on recompute, and makes the dedup key source-aware so a cmux and an Orca item for the same repo never collapse. `setAttention` gains a defaulted `source` param so existing callers are unchanged.

**Files:**
- Modify: `src/core/cmux/sort.ts` (`dedupeNewestPerWorkspace`)
- Modify: `src/core/services/store.ts` (`itemsBySource`, `setAttention`, `recompute`, `setSourceOffline`, `setOrcaActive`)
- Test: `test/orca.test.ts`

**Interfaces:**
- Consumes: `AttentionSource` (Task 1).
- Produces: `Store.setAttention(items: AttentionItem[], offline: boolean, source?: AttentionSource)` (default `"cmux"`); `Store.setSourceOffline(source: AttentionSource, offline: boolean)`; `Store.setOrcaActive(active: boolean)`. `dedupeNewestPerWorkspace` now keys by `${source}:${workspaceId}`.

- [ ] **Step 1: Write the failing test**

Append to `test/orca.test.ts`:

```ts
import { Store } from "../src/core/services/store.js";
import type { AttentionItem } from "../src/core/types.js";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern "merges cmux and orca|NOT deduped"`
Expected: FAIL — the second `setAttention` replaces `allItems` (first test sees only `o1`); dedup collapses the shared `workspaceId` (second test sees 1 item).

- [ ] **Step 3: Make the dedup key source-aware**

In `src/core/cmux/sort.ts`, change `dedupeNewestPerWorkspace`:

```ts
export function dedupeNewestPerWorkspace(sortedNewestFirst: AttentionItem[]): AttentionItem[] {
  const seen = new Set<string>();
  const out: AttentionItem[] = [];
  for (const it of sortedNewestFirst) {
    const key = `${it.source}:${it.workspaceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}
```

- [ ] **Step 4: Per-source slices in the store**

In `src/core/services/store.ts`, add the import of `AttentionSource`:

```ts
import type {
  AgentFilter,
  AppState,
  AttentionItem,
  AttentionSource,
  ProviderUsage,
  WorkspaceStatus,
} from "../types.js";
```

Add a private field to the `Store` class (next to `private state: AppState;`):

```ts
  /** Raw attention items per source, merged into allItems on recompute. */
  private itemsBySource: Record<AttentionSource, AttentionItem[]> = { cmux: [], orca: [] };
```

In `recompute()`, replace the first line so it merges the slices:

```ts
  private recompute(): void {
    const merged = [...this.itemsBySource.cmux, ...this.itemsBySource.orca];
    const allItems = sortNewestFirst(merged);
```

(Leave the rest of `recompute` unchanged.)

Replace `setAttention` and `setCmuxOffline` with source-aware versions:

```ts
  /** Replace one source's attention items (from its poll). */
  setAttention(items: AttentionItem[], offline: boolean, source: AttentionSource = "cmux"): void {
    this.itemsBySource[source] = items;
    const offlineField = source === "cmux" ? "cmuxOffline" : "orcaOffline";
    this.state = { ...this.state, [offlineField]: offline };
    this.recompute();
    this.emit();
  }

  /** Mark a single source offline/online without replacing its items. */
  setSourceOffline(source: AttentionSource, offline: boolean): void {
    const field = source === "cmux" ? "cmuxOffline" : "orcaOffline";
    if (this.state[field] === offline) return;
    this.state = { ...this.state, [field]: offline };
    this.emit();
  }

  /** Mark the Orca poller as active (auto-detected reachable and started). */
  setOrcaActive(active: boolean): void {
    if (this.state.orcaActive === active) return;
    this.state = { ...this.state, orcaActive: active };
    this.emit();
  }
```

Note: `recompute()` already reads `this.itemsBySource`; it no longer reads `this.state.allItems` as input, but it still writes `allItems` for inspection — keep the `allItems` write in the final `this.state = { ...this.state, allItems, items, offset }`.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, including the two new tests and the existing `store.test.ts` (which calls `setAttention(items, false)` — still valid via the default `source`).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/cmux/sort.ts src/core/services/store.ts test/orca.test.ts
git commit -F - <<'EOF'
feat(store): merge attention items per source

A second poller calling setAttention would clobber the single allItems
array and the workspace-keyed dedup would collapse a cmux and an Orca
item for the same repo. Hold items per source and merge on recompute,
and make the dedup key source-aware.

- Store keeps itemsBySource and concatenates them in recompute
- setAttention takes a source arg (defaults to cmux for existing callers)
- Add setSourceOffline/setOrcaActive; dedup keys by `${source}:${id}`
EOF
```

---

### Task 3: Orca `worktree ps` normalizer

Pure function turning `orca worktree ps --json` into `AttentionItem[]`, driven by Orca's worktree `status` rollup with per-agent detail. No Node/Elgato deps.

**Files:**
- Create: `src/core/orca/normalize.ts`
- Test: `test/orca.test.ts`

**Interfaces:**
- Produces:
  - `RawOrcaWorktree` (typed subset of a `ps` worktree row).
  - `normalizeWorktrees(raw: unknown, nowIso: string): AttentionItem[]` — `raw` is the `result.worktrees` array; maps each surfaced worktree to one item; drops non-attention worktrees.

- [ ] **Step 1: Write the failing test**

Append to `test/orca.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern "orca permission|orca done|orca working|orca active"`
Expected: FAIL — `Cannot find module '../src/core/orca/normalize.js'`.

- [ ] **Step 3: Implement the normalizer**

Create `src/core/orca/normalize.ts`:

```ts
import type { AgentKind, AttentionItem, AttentionReason } from "../types.js";

/** Per-agent row from `orca worktree ps --json`. Only fields we use are typed. */
export interface RawOrcaAgent {
  state?: unknown;             // "working" | "blocked" | "waiting" | "done"
  agentType?: unknown;         // "claude" | "codex" | ... (open set)
  prompt?: unknown;
  lastAssistantMessage?: unknown;
  interrupted?: unknown;
  stateStartedAt?: unknown;    // epoch ms
}

/** A worktree row from `orca worktree ps --json`. */
export interface RawOrcaWorktree {
  worktreeId?: unknown;
  repo?: unknown;
  displayName?: unknown;
  path?: unknown;
  branch?: unknown;
  status?: unknown;            // inactive|active|done|working|permission
  unread?: unknown;
  lastOutputAt?: unknown;      // epoch ms
  agents?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Map an Orca agentType to muxboard's narrower AgentKind. */
export function toAgentKind(agentType: string): AgentKind {
  const t = agentType.toLowerCase().trim();
  if (t === "claude") return "claude";
  if (t === "codex") return "codex";
  if (t === "pi") return "pi";
  return "unknown";
}

/** Pick the agent that best characterizes the worktree's current status. */
function primaryAgent(agents: RawOrcaAgent[], status: string): RawOrcaAgent | undefined {
  if (status === "permission") return agents.find((a) => str(a.state) === "waiting" || str(a.state) === "blocked") ?? agents[0];
  if (status === "working") return agents.find((a) => str(a.state) === "working") ?? agents[0];
  if (status === "done") return agents.find((a) => str(a.state) === "done") ?? agents[0];
  return agents[0];
}

/** ISO timestamp from an epoch-ms value, falling back to nowIso. */
function iso(ms: number | undefined, nowIso: string): string {
  return ms != null ? new Date(ms).toISOString() : nowIso;
}

/**
 * Normalize one `worktree ps` row to an AttentionItem, or null when the
 * worktree does not warrant a key (status active/inactive, i.e. no live agent
 * that finished or needs you).
 */
export function normalizeWorktree(raw: RawOrcaWorktree, nowIso: string): AttentionItem | null {
  const workspaceId = str(raw.worktreeId);
  const status = str(raw.status);
  if (!workspaceId || (status !== "permission" && status !== "working" && status !== "done")) {
    return null;
  }
  const agents = Array.isArray(raw.agents) ? (raw.agents as RawOrcaAgent[]) : [];
  const primary = primaryAgent(agents, status);
  const agent = primary ? toAgentKind(str(primary.agentType)) : "unknown";
  const title = str(raw.displayName) || str(raw.repo) || workspaceId;
  const message = primary ? str(primary.lastAssistantMessage) || str(primary.prompt) : "";
  const since = primary ? num(primary.stateStartedAt) : undefined;
  const createdAt = iso(since ?? num(raw.lastOutputAt), nowIso);

  let reason: AttentionReason;
  let activity: "working" | "waiting";
  let needsInput: true | undefined;
  let synthetic: true | undefined;

  if (status === "permission") {
    reason = "blocked";
    activity = "waiting";
    needsInput = true;
  } else if (status === "working") {
    reason = "waiting"; // overridden by the working activity in render/triage
    activity = "working";
    synthetic = true;
  } else {
    // status === "done"
    reason = primary && primary.interrupted === true ? "failed" : "finished";
    activity = "waiting";
  }

  return {
    id: workspaceId, // no notification; the worktree id is the focus key
    source: "orca",
    agent,
    workspaceId,
    repo: str(raw.repo) || undefined,
    title,
    reason,
    activity,
    needsInput,
    activitySince: since,
    body: "",
    message,
    createdAt,
    synthetic,
  };
}

/** Normalize the `result.worktrees` array, dropping non-attention rows. */
export function normalizeWorktrees(raw: unknown, nowIso: string): AttentionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AttentionItem[] = [];
  for (const row of raw) {
    if (row && typeof row === "object") {
      const item = normalizeWorktree(row as RawOrcaWorktree, nowIso);
      if (item) out.push(item);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern "orca permission|orca done|orca working|orca active"`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/orca/normalize.ts test/orca.test.ts
git commit -F - <<'EOF'
feat(orca): normalize `worktree ps` into attention items

Map Orca's worktree status rollup onto muxboard's reason model so Orca
sessions can share the queue: permission -> blocked+needsInput, done ->
finished (or failed when interrupted), working -> a synthetic running
item that sinks to the end. active/inactive worktrees are dropped.

- Pure normalizeWorktree/normalizeWorktrees over the ps JSON
- toAgentKind narrows Orca's open agentType set to claude/codex/pi/unknown
- Drive timestamps off stateStartedAt/lastOutputAt
EOF
```

---

### Task 4: `OrcaClient` — CLI wrapper (poll, focus, reachable)

Thin best-effort wrapper over the `orca` CLI, mirroring `CmuxClient`'s bin-resolution and injectable runner.

**Files:**
- Create: `src/core/orca/client.ts`
- Test: `test/orca.test.ts`

**Interfaces:**
- Consumes: `normalizeWorktrees` (Task 3).
- Produces:
  - `OrcaClient` with `listAttention(): Promise<AttentionItem[]>`, `focus(item: AttentionItem): Promise<void>`, `reachable(): Promise<boolean>`.
  - `OrcaClientOptions { bin?: string; runner?: CommandRunner; now?: () => number }` reusing `CommandRunner` from `../cmux/client.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/orca.test.ts`:

```ts
import { OrcaClient } from "../src/core/orca/client.js";

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
    return { stdout: "{}", stderr: "" };
  };
  const client = new OrcaClient({ runner });
  await client.focus({ id: "r::/p", source: "orca", agent: "claude", workspaceId: "r::/p", title: "t", reason: "blocked", activity: "waiting", body: "", message: "", createdAt: "2026-06-23T12:00:00Z" });
  const focusCall = calls.find((a) => a.includes("focus"));
  assert.ok(focusCall);
  assert.ok(focusCall.includes("term_new"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern "OrcaClient"`
Expected: FAIL — `Cannot find module '../src/core/orca/client.js'`.

- [ ] **Step 3: Implement the client**

Create `src/core/orca/client.ts`:

```ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AttentionItem } from "../types.js";
import type { CommandRunner } from "../cmux/client.js";
import { normalizeWorktrees } from "./normalize.js";

const execFileAsync = promisify(execFile);

/** Common dirs Orca's CLI is installed into, to resolve a bare `orca`. */
const ORCA_DIRS = [
  "/Applications/Orca.app/Contents/Resources/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.HOME ? join(process.env.HOME, ".local/bin") : "",
].filter(Boolean);

const AUGMENTED_PATH = [...ORCA_DIRS, process.env.PATH ?? ""].filter(Boolean).join(":");

/** Resolve a (possibly bare) orca command to an absolute path. */
export function resolveOrcaBin(bin: string): string {
  if (isAbsolute(bin)) return bin;
  if (bin.includes("/")) return bin;
  for (const dir of ORCA_DIRS) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return bin;
}

const defaultRunner: CommandRunner = async (bin, args) => {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PATH: AUGMENTED_PATH },
  });
  return { stdout, stderr };
};

export interface OrcaClientOptions {
  bin?: string;
  runner?: CommandRunner;
  now?: () => number;
}

interface OrcaEnvelope<T> {
  ok?: unknown;
  result?: T;
}

/** Thin best-effort wrapper over the `orca` CLI. */
export class OrcaClient {
  private readonly bin: string;
  private readonly runner: CommandRunner;
  private readonly now: () => number;

  constructor(opts: OrcaClientOptions = {}) {
    this.bin = resolveOrcaBin(opts.bin ?? "orca");
    this.runner = opts.runner ?? defaultRunner;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Poll `worktree ps` and normalize to attention items. */
  async listAttention(): Promise<AttentionItem[]> {
    const { stdout } = await this.runner(this.bin, ["worktree", "ps", "--json"]);
    const env = JSON.parse(stdout) as OrcaEnvelope<{ worktrees?: unknown }>;
    const nowIso = new Date(this.now()).toISOString();
    return normalizeWorktrees(env.result?.worktrees, nowIso);
  }

  /** True when `orca status` reports a reachable runtime. */
  async reachable(): Promise<boolean> {
    try {
      const { stdout } = await this.runner(this.bin, ["status", "--json"]);
      const env = JSON.parse(stdout) as OrcaEnvelope<{ runtime?: { reachable?: unknown } }>;
      return env.ok === true && env.result?.runtime?.reachable === true;
    } catch {
      return false;
    }
  }

  /**
   * Focus an Orca worktree: resolve its most-recently-active terminal handle
   * and switch to it. There is no worktree-focus verb, so we go via a terminal.
   */
  async focus(item: AttentionItem): Promise<void> {
    const { stdout } = await this.runner(this.bin, ["terminal", "list", "--json"]);
    const env = JSON.parse(stdout) as OrcaEnvelope<{ terminals?: RawTerminal[] }>;
    const terminals = (env.result?.terminals ?? []).filter((t) => t.worktreeId === item.workspaceId);
    if (terminals.length === 0) throw new Error(`no live terminal for worktree ${item.workspaceId}`);
    const handle = terminals.reduce((a, b) => ((b.lastOutputAt ?? 0) > (a.lastOutputAt ?? 0) ? b : a)).handle;
    if (!handle) throw new Error(`no terminal handle for worktree ${item.workspaceId}`);
    await this.runner(this.bin, ["terminal", "focus", "--terminal", handle, "--json"]);
  }
}

interface RawTerminal {
  handle?: string;
  worktreeId?: string;
  lastOutputAt?: number;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern "OrcaClient"`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/orca/client.ts test/orca.test.ts
git commit -F - <<'EOF'
feat(orca): add OrcaClient CLI wrapper

Wrap the orca CLI for the poller and key actions: listAttention runs
`worktree ps --json`, reachable gates on `status` (parsing ok since the
exit code is always 0), and focus resolves a worktree's most recent
terminal handle and switches to it (there is no worktree-focus verb).

- Bin resolution + augmented PATH for the Stream Deck minimal env
- Injectable CommandRunner (reused from the cmux client) for tests
EOF
```

---

### Task 5: `OrcaService` — polling loop

Polls `OrcaClient` on an interval and pushes items into the store under `source: "orca"`, with the same robustness rules as `CmuxService`.

**Files:**
- Create: `src/core/services/orcaService.ts`
- Test: `test/orca.test.ts`

**Interfaces:**
- Consumes: `OrcaClient` (Task 4), `Store.setAttention(..., "orca")` / `setSourceOffline` (Task 2).
- Produces: `OrcaService` with `start()`, `stop()`, `poll(): Promise<void>`; `OrcaServiceOptions { client: OrcaClient; store: Store; pollMs?: number; logger?: Logger }`.

- [ ] **Step 1: Write the failing test**

Append to `test/orca.test.ts`:

```ts
import { OrcaService } from "../src/core/services/orcaService.js";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern "OrcaService pushes"`
Expected: FAIL — `Cannot find module '../src/core/services/orcaService.js'`.

- [ ] **Step 3: Implement the service**

Create `src/core/services/orcaService.ts`:

```ts
import type { OrcaClient } from "../orca/client.js";
import type { Store } from "./store.js";
import { type Logger, silentLogger } from "./logger.js";

export interface OrcaServiceOptions {
  client: OrcaClient;
  store: Store;
  /** Poll interval in ms (default 1500). */
  pollMs?: number;
  logger?: Logger;
}

/**
 * Polls Orca for the attention queue and pushes it into the store under the
 * "orca" source. Same robustness rules as CmuxService: keep the last good items
 * on a transient miss, and require two consecutive failures before flipping the
 * orca feed offline.
 */
export class OrcaService {
  private readonly client: OrcaClient;
  private readonly store: Store;
  private readonly pollMs: number;
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private consecutiveFailures = 0;

  constructor(opts: OrcaServiceOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.pollMs = opts.pollMs ?? 1500;
    this.log = opts.logger ?? silentLogger;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const items = await this.client.listAttention();
      this.consecutiveFailures = 0;
      this.store.setAttention(items, false, "orca");
    } catch (err) {
      this.consecutiveFailures++;
      this.log.warn(`orca poll failed (${this.consecutiveFailures}): ${message(err)}`);
      if (this.consecutiveFailures >= 2) {
        this.store.setSourceOffline("orca", true);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern "OrcaService pushes"`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/orcaService.ts test/orca.test.ts
git commit -F - <<'EOF'
feat(orca): add OrcaService polling loop

Poll OrcaClient on an interval and push items into the store under the
orca source, mirroring CmuxService: never overlap polls, keep the last
good items on a transient miss, and require two consecutive failures
before flipping the orca feed offline.
EOF
```

---

### Task 6: Per-source focus/dismiss backend

Generalizes the actions' hard-wired `runtime.cmux.*` into a per-source `AttentionBackend`, so an Orca key jumps via Orca and a cmux key via cmux. Behavior for cmux is unchanged.

**Files:**
- Modify: `src/runtime.ts` (`AttentionBackend`, `bringToFront`, `Runtime.backends`)
- Modify: `src/actions/attentionKey.ts` (dispatch by `item.source`)
- Modify: `src/actions/dialStrip.ts` (jump dispatch by source)
- Test: `test/orca.test.ts`

**Interfaces:**
- Produces:
  - `interface AttentionBackend { focus(item): Promise<void>; dismiss(item): Promise<void>; bringToFront(): void }`
  - `makeCmuxBackend(cmux: CmuxClient, logger: Logger, markOpened: (id: string) => void): AttentionBackend`
  - `makeOrcaBackend(orca: OrcaClient, logger: Logger): AttentionBackend`
  - `Runtime.backends: Record<AttentionSource, AttentionBackend>`
- Consumes: `OrcaClient.focus` (Task 4); `CmuxClient` focus/dismiss/select (existing).

- [ ] **Step 1: Write the failing test**

Append to `test/orca.test.ts`:

```ts
import { makeOrcaBackend } from "../src/runtime.js";

test("orca backend dismiss focuses the worktree (clears unread)", async () => {
  const calls: AttentionItem[] = [];
  const orca = { async focus(it: AttentionItem) { calls.push(it); } } as unknown as import("../src/core/orca/client.js").OrcaClient;
  const backend = makeOrcaBackend(orca, { info() {}, warn() {}, error() {} });
  const it = item({ id: "o1", source: "orca" });
  await backend.dismiss(it); // long-press on an Orca key
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "o1");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern "orca backend dismiss"`
Expected: FAIL — `makeOrcaBackend` is not exported from `runtime.js`.

- [ ] **Step 3: Add the backend abstraction to `runtime.ts`**

In `src/runtime.ts`, add imports at the top (after the existing type imports):

```ts
import type { AttentionItem, AttentionSource } from "./core/types.js";
import type { OrcaClient } from "./core/orca/client.js";
```

Add the interface and two factories (below `bringCmuxToFront`):

```ts
/** Per-source focus/dismiss capability resolved by item.source. */
export interface AttentionBackend {
  /** Bring the source app forward and jump to the item's surface. */
  focus(item: AttentionItem): Promise<void>;
  /** Long-press action. cmux removes the notification; Orca re-focuses. */
  dismiss(item: AttentionItem): Promise<void>;
  /** Bring the source app forward (no surface jump). */
  bringToFront(): void;
}

/** Bring an app to the foreground on macOS (best-effort). */
function bringAppToFront(app: string, logger: Logger): void {
  execFile("open", ["-a", app], (err) => {
    if (err) logger.warn(`bring ${app} to front failed: ${err.message}`);
  });
}

export function makeCmuxBackend(
  cmux: CmuxClient,
  logger: Logger,
  markOpened: (id: string) => void,
): AttentionBackend {
  return {
    bringToFront: () => bringAppToFront("cmux", logger),
    async focus(item) {
      bringAppToFront("cmux", logger);
      if (item.synthetic) {
        await cmux.selectWorkspace(item.workspaceId);
        return;
      }
      try {
        await cmux.openNotification(item.id);
      } catch (err) {
        logger.warn(`open-notification failed, falling back: ${err instanceof Error ? err.message : err}`);
        await cmux.selectWorkspace(item.workspaceId);
      }
      markOpened(item.id);
    },
    async dismiss(item) {
      await cmux.dismissNotification(item.id);
    },
  };
}

export function makeOrcaBackend(orca: OrcaClient, logger: Logger): AttentionBackend {
  return {
    bringToFront: () => bringAppToFront("Orca", logger),
    async focus(item) {
      bringAppToFront("Orca", logger);
      await orca.focus(item);
    },
    // No dismiss primitive in Orca; focusing the worktree clears its unread.
    async dismiss(item) {
      bringAppToFront("Orca", logger);
      await orca.focus(item);
    },
  };
}
```

Add the import of `CmuxClient` if not present (it is already imported as a type — change it to a value-free type import is fine; `makeCmuxBackend` only needs the type). Keep the existing `import type { CmuxClient }`.

Add `backends` to the `Runtime` interface (after `cmux: CmuxClient;`):

```ts
  /** Per-source focus/dismiss backends, resolved by item.source. */
  backends: Record<AttentionSource, AttentionBackend>;
```

(Keep `bringCmuxToFront` exported for now; it is replaced at call sites in the next steps and may be removed once unused.)

- [ ] **Step 4: Dispatch by source in `attentionKey.ts`**

In `src/actions/attentionKey.ts`, replace the `dismiss` and `focus` methods with backend-dispatched versions:

```ts
  /** Long-press: cmux removes the notification; Orca re-focuses the worktree. */
  private async dismiss(item: AttentionItem, action: KeyAction): Promise<void> {
    try {
      await this.runtime.backends[item.source].dismiss(item);
      await action.showOk();
    } catch (err) {
      this.runtime.logger.warn(`dismiss failed: ${message(err)}`);
      await action.showAlert();
    }
  }

  /** Bring the source app forward and jump to the pane (tap behavior). */
  private async focus(item: AttentionItem, action: KeyAction): Promise<void> {
    try {
      await this.runtime.backends[item.source].focus(item);
    } catch (err) {
      this.runtime.logger.error(`focus failed: ${message(err)}`);
      await action.showAlert();
    }
  }
```

Remove the now-unused import of `bringCmuxToFront` from this file (the line `import { bringCmuxToFront } from "../runtime.js";`).

- [ ] **Step 5: Dispatch by source in `dialStrip.ts` (jump to newest)**

In `src/actions/dialStrip.ts`, replace the `case 0:` jump block in `handlePress`:

```ts
      case 0: {
        // Jump to the newest visible attention item.
        const item = this.runtime.store.newestVisible();
        if (!item) return;
        try {
          await this.runtime.backends[item.source].focus(item);
        } catch (err) {
          this.runtime.logger.warn(`dial jump failed: ${message(err)}`);
          await a.showAlert();
        }
        break;
      }
```

Remove the now-unused `import { bringCmuxToFront } from "../runtime.js";` line.

- [ ] **Step 6: Run the tests**

Run: `npm test -- --test-name-pattern "orca backend dismiss"`
Expected: PASS.
Run: `npm run typecheck`
Expected: errors in `plugin.ts` only (Runtime now requires `backends`) — fixed in Task 8. To verify just this task's files, you may temporarily run `npx tsc --noEmit` and confirm the only errors reference `runtime.backends` missing in `plugin.ts`. Leave them; Task 8 resolves them.

- [ ] **Step 7: Commit**

```bash
git add src/runtime.ts src/actions/attentionKey.ts src/actions/dialStrip.ts test/orca.test.ts
git commit -F - <<'EOF'
feat(actions): dispatch focus/dismiss per source

Focus and dismiss were hard-wired to runtime.cmux; an Orca key must jump
via Orca instead. Introduce an AttentionBackend resolved by item.source,
move cmux's open/select/dismiss logic into a cmux backend, and add an
Orca backend whose focus (and dismiss, which has no Orca primitive) jumps
to the worktree's terminal. cmux behavior is unchanged.

- AttentionBackend + makeCmuxBackend/makeOrcaBackend in runtime.ts
- attentionKey and dialStrip resolve runtime.backends[item.source]
- plugin.ts wiring follows in a later task
EOF
```

---

### Task 7: Source badge + per-source offline tile

Adds the logo-derived source badge to each key and generalizes the offline tile to show only when every active source is offline.

**Files:**
- Create: `src/core/render/sourceIcons.ts`
- Modify: `src/core/render/keyRender.ts` (`renderKey` badge, `renderCmuxOffline` → `renderSourceOffline`)
- Modify: `src/actions/attentionKey.ts` (offline tile condition + label)
- Test: `test/orca.test.ts`

**Interfaces:**
- Produces:
  - `sourceGlyphSvg(source: AttentionSource, x: number, y: number, size: number, color: string): string`
  - `renderSourceOffline(label: string): string` (replaces `renderCmuxOffline`)
- Consumes: `AttentionItem.source` (Task 1), `AppState` offline flags (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `test/orca.test.ts`:

```ts
import { sourceGlyphSvg } from "../src/core/render/sourceIcons.js";
import { renderKey } from "../src/core/render/keyRender.js";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern "sourceGlyphSvg|source badge"`
Expected: FAIL — `Cannot find module '../src/core/render/sourceIcons.js'`.

- [ ] **Step 3: Create the source icons module**

Create `src/core/render/sourceIcons.ts`. (The Orca path is the real `logo.svg` mark from the Orca app bundle; the cmux mark is a hand-authored terminal-prompt monogram — swap for an official mark later if desired.)

```ts
import type { AttentionSource } from "../types.js";

interface SourceIcon {
  viewBox: string;
  /** SVG body using `currentColor`; the color is substituted at render time. */
  body: string;
}

const SOURCE_ICONS: Record<AttentionSource, SourceIcon> = {
  orca: {
    viewBox: "0 0 318.60232 202.66667",
    body:
      '<path transform="translate(-6.6666669,-70.666669)" fill="currentColor" d="m 177.81311,248.33334 c 23.82304,-41.29793 40.54045,-66.84626 49.51207,-75.66667 6.81685,-6.70196 10.07373,-8.7374 20.07265,-12.54475 34.57822,-13.16655 61.04674,-26.78733 72.37222,-37.24295 9.62924,-8.88966 9.34286,-9.01142 -23.43671,-9.964 -35.71756,-1.03796 -43.72989,0.42119 -62.17546,11.323 -16.72118,9.88265 -34.20103,30.11225 -42.74704,49.47157 -2.57353,5.82985 -14.81294,44.3056 -27.96399,87.90747 -2.86036,9.48343 -3.02466,11.71633 -0.86213,11.71633 0.44382,0 7.29659,-11.25 15.22839,-25 z m -65.14644,-8.32267 C 120,239.3326 130.5,237.50979 136,235.95998 c 5.5,-1.5498 12.25,-3.13783 15,-3.52895 2.75,-0.39111 5,-0.95485 5,-1.25275 0,-0.29789 2.15135,-7.58487 4.78078,-16.19328 8.49209,-27.80201 12.21334,-40.41629 21.13747,-71.65166 4.81891,-16.86667 11.23502,-39.185 14.25802,-49.596301 5.12803,-17.66103 5.74763,-23.07037 2.64253,-23.07037 -1.84887,0 -4.07048,6.908293 -16.72243,52.000001 -21.78975,77.65896 -20.80806,74.74393 -26.84794,79.72251 -7.5925,6.25838 -25.03916,14.82524 -36.10856,17.73044 -17.0947,4.48656 -33.410599,3.86724 -53.116765,-2.01622 -18.569242,-5.54403 -23.142662,-5.80284 -33.639754,-1.9037 -5.875424,2.18242 -9.864152,5.04363 -16.716684,11.99127 -4.95,5.0187 -9.0000001,10.02884 -9.0000001,11.13364 0,1.75174 5.9276921,2.00299 46.3333351,1.96383 25.483334,-0.0247 52.333338,-0.59969 59.666668,-1.27777 z M 252.69513,104.63708 c 12.18267,-3.48651 15.77304,-7.895503 9.63821,-11.835773 -10.19296,-6.546726 -36.19849,-1.77301 -41.19436,7.561863 -1.2556,2.3461 -0.98698,3.2037 1.68353,5.375 2.69471,2.19098 4.59991,2.47691 12.53928,1.88189 5.14899,-0.3859 12.94899,-1.72824 17.33334,-2.98298 z"/>',
  },
  cmux: {
    // Terminal-prompt monogram: a chevron and an underscore in a rounded square.
    viewBox: "0 0 100 100",
    body:
      '<g fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M30 33 L50 50 L30 67"/><path d="M56 67 H74"/></g>',
  },
};

/**
 * Inline a source badge at (x,y), scaled so its larger viewBox dimension equals
 * `size`, tinted `color`. Uses a <g transform> (translate+scale) rather than a
 * nested <svg>, matching providerIconSvg, since the Stream Deck SVG renderer
 * does not handle nested <svg> scaling. `currentColor` in the body is replaced
 * with the literal color (resvg does not resolve currentColor reliably).
 */
export function sourceGlyphSvg(
  source: AttentionSource,
  x: number,
  y: number,
  size: number,
  color: string,
): string {
  const icon = SOURCE_ICONS[source];
  if (!icon) return "";
  const [minX, minY, vbW, vbH] = icon.viewBox.split(/[\s,]+/).map(Number);
  const s = size / Math.max(vbW || 1, vbH || 1);
  const tx = x - (minX || 0) * s;
  const ty = y - (minY || 0) * s;
  const body = icon.body.replaceAll("currentColor", color);
  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})">${body}</g>`;
}
```

- [ ] **Step 4: Render the badge in `keyRender.ts`**

In `src/core/render/keyRender.ts`, add the import:

```ts
import { sourceGlyphSvg } from "./sourceIcons.js";
```

In `renderKey`, build the badge just before the final `return`:

```ts
  // Source badge bottom-right (muted): the real Orca mark / a cmux monogram, so
  // a key's origin is legible at a glance when both sources share the board.
  const badge = sourceGlyphSvg(item.source, S - 30, S - 26, 20, "#7c828d");
```

Then add `${badge}` inside the `<g ...>` block, right after the status-line `<text ...>` and before the closing `</g>`:

```ts
    <text x="12" y="${S - 11}" font-size="15" font-weight="800" fill="${status.color}" letter-spacing="0.5">${escapeXml(status.text)}</text>
    ${badge}
  </g>
```

- [ ] **Step 5: Generalize the offline tile**

In `src/core/render/keyRender.ts`, rename `renderCmuxOffline` to `renderSourceOffline(label: string)` and use the label:

```ts
/**
 * Render a single muted "<label> unavailable" tile for slot 1 when every active
 * feed is down, so the keys communicate the outage instead of going dark.
 */
export function renderSourceOffline(label: string): string {
  const S = KEY_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="18" fill="#1a1416"/>
  <rect x="4" y="4" width="${S - 8}" height="${S - 8}" rx="15" fill="none" stroke="#7d3b3b" stroke-width="3"/>
  <text x="${S / 2}" y="64" font-size="40" text-anchor="middle" fill="#c66">⚠</text>
  <text x="${S / 2}" y="98" font-size="20" font-weight="700" text-anchor="middle" fill="#e6b3b3" font-family="-apple-system, Helvetica, Arial, sans-serif">${escapeXml(label)}</text>
  <text x="${S / 2}" y="120" font-size="16" text-anchor="middle" fill="#b88" font-family="-apple-system, Helvetica, Arial, sans-serif">offline</text>
</svg>`;
}
```

- [ ] **Step 6: Update the offline tile condition in `attentionKey.ts`**

In `src/actions/attentionKey.ts`, update the import:

```ts
import { renderKey, renderEmptyKey, renderSourceOffline } from "../core/render/keyRender.js";
```

In `renderOne`, replace the offline branch:

```ts
    let svg: string;
    const cmuxDown = state.cmuxOffline;
    const orcaDown = !state.orcaActive || state.orcaOffline;
    const allDown = cmuxDown && orcaDown && (state.cmuxOffline || (state.orcaActive && state.orcaOffline));
    if (allDown && slot === 0 && state.items.length === 0) {
      const labels = [state.cmuxOffline ? "cmux" : null, state.orcaActive && state.orcaOffline ? "orca" : null].filter(Boolean);
      svg = renderSourceOffline(labels.join(" + ") || "cmux");
    } else {
```

(The `allDown` extra clause ensures the tile never appears purely because Orca is inactive while cmux is online: it requires at least one source to actually be offline.)

- [ ] **Step 7: Run the tests + check other references**

Run: `npm test`
Expected: PASS. If `test/render.test.ts` referenced `renderCmuxOffline`, update it to `renderSourceOffline("cmux")` and assert it contains `cmux`.
Run: `npm run typecheck`
Expected: errors only in `plugin.ts` (`backends`), resolved in Task 8.

- [ ] **Step 8: Commit**

```bash
git add src/core/render/sourceIcons.ts src/core/render/keyRender.ts src/actions/attentionKey.ts test/orca.test.ts
git commit -F - <<'EOF'
feat(render): badge keys by source; per-source offline tile

With cmux and Orca sharing the board, a key needs to show which tool it
belongs to, and the offline tile must not blank the board when only one
feed is down. Add a muted source badge (the real Orca logo path / a cmux
monogram) bottom-right of each key, and gate the offline tile on every
active source being offline, labeling whichever are down.

- sourceIcons.ts with a sourceGlyphSvg helper mirroring providerIconSvg
- renderCmuxOffline -> renderSourceOffline(label)
- attentionKey shows the tile only when all active feeds are offline
EOF
```

---

### Task 8: Config, plugin wiring, and Orca auto-detect

Adds the Orca config knobs, builds the backends, and starts the Orca poller when the runtime is reachable (auto), forced on, or never (forced off).

**Files:**
- Modify: `src/config.ts` (`orcaBin`, `orcaPollMs`, `enableOrca` + resolve/defaults)
- Modify: `src/plugin.ts` (construct OrcaClient/Service, backends, auto-detect start, shutdown)
- Test: `test/orca.test.ts`

**Interfaces:**
- Consumes: `OrcaClient` (T4), `OrcaService` (T5), `makeCmuxBackend`/`makeOrcaBackend` (T6), `Store.setOrcaActive` (T2).
- Produces: `MuxboardConfig.orcaBin: string`, `orcaPollMs: number`, `enableOrca: "auto" | boolean`.

- [ ] **Step 1: Write the failing test**

Append to `test/orca.test.ts`:

```ts
import { resolveConfig, DEFAULT_CONFIG } from "../src/config.js";

test("resolveConfig defaults and coerces Orca knobs", () => {
  assert.equal(DEFAULT_CONFIG.enableOrca, "auto");
  assert.equal(DEFAULT_CONFIG.orcaBin, "orca");
  const r = resolveConfig({ enableOrca: true, orcaBin: " /usr/local/bin/orca ", orcaPollMs: 1 });
  assert.equal(r.enableOrca, true);
  assert.equal(r.orcaBin, "/usr/local/bin/orca");
  assert.equal(r.orcaPollMs, 500); // clamped to the 500 floor
  assert.equal(resolveConfig({ enableOrca: "nonsense" as unknown as "auto" }).enableOrca, "auto");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern "resolveConfig defaults and coerces Orca"`
Expected: FAIL — `enableOrca`/`orcaBin`/`orcaPollMs` are not on the config.

- [ ] **Step 3: Extend the config type, defaults, and resolver**

In `src/config.ts`, add to the `MuxboardConfig` interface (after `busyCpuPercent: number;`):

```ts
  /** orca CLI binary path or name. */
  orcaBin: string;
  /** Orca poll interval (ms). */
  orcaPollMs: number;
  /**
   * Whether to run the Orca poller. "auto" (default) starts it only when an
   * Orca runtime is reachable; true forces it on; false disables it.
   */
  enableOrca: "auto" | boolean;
```

Add to `DEFAULT_CONFIG` (after `busyCpuPercent: 40,`):

```ts
  orcaBin: "orca",
  orcaPollMs: 1500,
  enableOrca: "auto",
```

Add to the object returned by `resolveConfig` (after the `busyCpuPercent:` line):

```ts
    orcaBin: nonEmpty(p.orcaBin) ?? DEFAULT_CONFIG.orcaBin,
    orcaPollMs: clampInt(p.orcaPollMs, 500, 10_000, DEFAULT_CONFIG.orcaPollMs),
    enableOrca: coerceEnableOrca(p.enableOrca),
```

Add the coercer at the bottom of `src/config.ts`:

```ts
function coerceEnableOrca(v: unknown): "auto" | boolean {
  if (v === true || v === false) return v;
  return "auto";
}
```

- [ ] **Step 4: Run the config test**

Run: `npm test -- --test-name-pattern "resolveConfig defaults and coerces Orca"`
Expected: PASS.

- [ ] **Step 5: Wire the plugin**

In `src/plugin.ts`, add imports:

```ts
import { OrcaClient } from "./core/orca/client.js";
import { OrcaService } from "./core/services/orcaService.js";
import { makeCmuxBackend, makeOrcaBackend } from "./runtime.js";
```

After the `cmux` client is constructed and before `runtime` is assembled, construct the Orca client + service:

```ts
  const orca = new OrcaClient({ bin: config.orcaBin });
  const orcaService = new OrcaService({ client: orca, store, pollMs: config.orcaPollMs, logger });
```

In the `runtime` object literal, add `backends` (after `markOpened`):

```ts
    backends: {
      cmux: makeCmuxBackend(cmux, logger, (id) => runtime.markOpened(id)),
      orca: makeOrcaBackend(orca, logger),
    },
```

(Because `runtime` references itself in `markOpened`, keep `backends` referencing `runtime.markOpened` via the arrow above — `runtime` is in scope by the time a key is pressed.)

After the existing `cmuxService.start(); cmuxEventsService.start(); codexbarService.start();` block, add Orca auto-detect/start:

```ts
  // Start the Orca poller per config: forced on, or auto when a runtime is
  // reachable. In auto mode, if Orca isn't up yet, re-probe on a slow cadence so
  // opening Orca later brings the board to life without a plugin restart.
  let orcaStarted = false;
  let orcaProbe: ReturnType<typeof setInterval> | null = null;
  const startOrca = (): void => {
    if (orcaStarted) return;
    orcaStarted = true;
    store.setOrcaActive(true);
    orcaService.start();
    logger.info("Orca poller started.");
  };
  const tryStartOrca = async (): Promise<void> => {
    if (orcaStarted) return;
    if (config.enableOrca === false) return;
    if (config.enableOrca === true || (await orca.reachable())) {
      startOrca();
      if (orcaProbe) { clearInterval(orcaProbe); orcaProbe = null; }
    }
  };
  void tryStartOrca();
  if (config.enableOrca === "auto") {
    orcaProbe = setInterval(() => void tryStartOrca(), 30_000);
  }
```

Update the `shutdown` closure to stop the Orca service and clear the probe:

```ts
  const shutdown = (): void => {
    cmuxEventsService.stop();
    cmuxService.stop();
    codexbarService.stop();
    orcaService.stop();
    if (orcaProbe) clearInterval(orcaProbe);
  };
```

- [ ] **Step 6: Typecheck, build, and full suite**

Run: `npm run typecheck`
Expected: no errors anywhere now (Task 6/7 `plugin.ts` gaps resolved).
Run: `npm test`
Expected: PASS.
Run: `npm run build`
Expected: rollup builds with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/plugin.ts test/orca.test.ts
git commit -F - <<'EOF'
feat(orca): config knobs, plugin wiring, and auto-detect

Wire the Orca source into the runtime and start it per config. enableOrca
defaults to "auto": probe `orca status` and start the poller only when a
runtime is reachable, re-probing on a slow cadence so opening Orca later
lights up the board without a restart. true forces on, false disables.

- Add orcaBin/orcaPollMs/enableOrca with defaults and coercion
- Construct OrcaClient/OrcaService and the per-source backends
- Start/stop the poller; mark the source active for the offline tile
EOF
```

---

### Task 9: Headless preview fixture for a mixed board

Extends the headless preview so `npm run preview` renders a board mixing cmux and Orca keys (both badges visible), and documents the feature in the README.

**Files:**
- Modify: `scripts/preview.ts` (add Orca items to the rendered fixture)
- Modify: `README.md` (a short "Orca support" subsection)
- Test: manual (`npm run preview`) — no unit assertion needed beyond a render smoke check.

**Interfaces:**
- Consumes: `normalizeWorktrees` (T3), `renderKey` (T7).

- [ ] **Step 1: Inspect the current preview script**

Run: `sed -n '1,80p' scripts/preview.ts`
Expected: see how it loads cmux fixtures and renders keys to `out/dashboard.png`. Identify the array of items it renders.

- [ ] **Step 2: Add an Orca fixture and merge it into the preview**

Create `test/fixtures/orca-worktree-ps.json` with a representative `result.worktrees` array:

```json
{ "ok": true, "result": { "worktrees": [
  { "worktreeId": "r1::/p/auth", "repo": "auth-svc", "displayName": "fix-login", "status": "permission",
    "lastOutputAt": 1782174656809,
    "agents": [{ "state": "waiting", "agentType": "claude", "lastAssistantMessage": "May I edit auth.ts?", "stateStartedAt": 1782174600000 }] },
  { "worktreeId": "r2::/p/api", "repo": "api", "displayName": "perf", "status": "working",
    "lastOutputAt": 1782174650000,
    "agents": [{ "state": "working", "agentType": "codex", "stateStartedAt": 1782174500000 }] }
] } }
```

In `scripts/preview.ts`, after the cmux items are built, merge Orca items (adjust the variable name to match the script):

```ts
import { normalizeWorktrees } from "../src/core/orca/normalize.js";
// ...
const orcaRaw = JSON.parse(readFileSync(new URL("../test/fixtures/orca-worktree-ps.json", import.meta.url), "utf8"));
const orcaItems = normalizeWorktrees(orcaRaw.result.worktrees, new Date("2026-06-23T12:05:00Z").toISOString());
// merge into the list the script renders, e.g.:
const items = [...cmuxItems, ...orcaItems];
```

(Use the existing fixture-load idiom in the script; the key point is that `items` passed to the renderer now includes the two Orca items.)

- [ ] **Step 3: Render and eyeball**

Run: `npm run preview`
Expected: `out/dashboard.png` regenerates. Open it (or `Read` it) and confirm: the Orca permission key shows `NEEDS YOU`/`PERMISSION` styling with the Orca badge bottom-right; the Orca working key shows `● working` with the Orca badge; cmux keys show the cmux monogram badge.

- [ ] **Step 4: Document it in the README**

In `README.md`, under "How it works" (or a new "## Orca support" section after the cmux contract), add:

```markdown
## Orca support

Muxboard also surfaces [Orca](https://onorca.dev) worktrees alongside cmux
panes on the same keys. It polls `orca worktree ps --json`: a worktree whose
agent needs you (`permission`) shows as a needs-input key, a finished agent
(`done`) as finished (or failed when interrupted), and an actively working
agent as a working key that sinks to the end. Each key carries a small badge —
the Orca mark or a cmux monogram — so you can tell the two apart.

Orca is **auto-detected**: the poller starts only when an Orca runtime is
reachable (`orca status`), so cmux-only users see no change. Set
`enableOrca: true|false` in the plugin's global settings to force it on or off,
and `orcaBin`/`orcaPollMs` to tune the binary path and cadence.

Pressing an Orca key brings Orca forward and jumps to the worktree's most
recent terminal (`orca terminal focus`). Orca has no dismiss primitive, so a
long-press focuses the worktree too (which clears its unread in Orca).
```

- [ ] **Step 5: Final full verification**

Run: `npm test && npm run typecheck && npm run build && npm run preview`
Expected: all green; `out/dashboard.png` shows the mixed board.

- [ ] **Step 6: Commit**

```bash
git add scripts/preview.ts test/fixtures/orca-worktree-ps.json README.md
git commit -F - <<'EOF'
docs(orca): mixed-board preview fixture and README section

Show the feature without hardware: extend the headless preview to render
a board mixing cmux panes and Orca worktrees (both badges visible), and
document Orca support, auto-detection, and the focus/long-press behavior.
EOF
```

---

## Self-Review

**Spec coverage:**
- Parallel OrcaService/OrcaClient, no events service → Tasks 4, 5. ✓
- Per-source store slices merged on recompute; `${source}:${workspaceId}` dedup → Task 2. ✓
- State mapping (permission→blocked+needsInput; done/interrupted→failed; done→finished; working→synthetic; active/inactive dropped) → Task 3. ✓
- `source` field + stamping cmux → Task 1. ✓
- Focus = `open -a Orca` + terminal-list (max lastOutputAt) + terminal focus; long-press focuses (clears unread); per-source backend → Tasks 4, 6. ✓
- Auto-detect via `orca status` reachable, with config override and slow re-probe; per-source offline tile → Tasks 7, 8. ✓
- Logo-derived Orca badge + cmux badge → Task 7. ✓
- Config orcaBin/orcaPollMs/enableOrca → Task 8. ✓
- Tests: normalize matrix, client, service, store merge, render; preview fixture → Tasks 3–9. ✓
- Trademark note: documented in the spec; the cmux/Orca marks live isolated in `sourceIcons.ts` for easy swap (Task 7). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one judgment call ("use the existing fixture-load idiom" in Task 9 Step 2) is bounded by reading the script in Step 1 and shows the exact merge code.

**Type consistency:** `setAttention(items, offline, source?)`, `setSourceOffline(source, offline)`, `setOrcaActive(active)`, `normalizeWorktrees(raw, nowIso)`, `OrcaClient.{listAttention,reachable,focus}`, `AttentionBackend.{focus,dismiss,bringToFront}`, `makeCmuxBackend(cmux, logger, markOpened)`, `makeOrcaBackend(orca, logger)`, `sourceGlyphSvg(source,x,y,size,color)`, `renderSourceOffline(label)` are used consistently across tasks. `AttentionItem.source` is required from Task 1 onward and stamped by both normalizers.
