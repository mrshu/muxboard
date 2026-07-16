# Orca as a second attention source

Status: design / approved to plan
Date: 2026-06-23

## Goal

Muxboard today surfaces only [cmux](https://cmux.com/) panes whose coding agents
need attention. This adds [Orca](https://onorca.dev) as a **second, coexisting**
attention source: Orca worktrees whose agents have finished, been interrupted,
or are waiting on the user appear on the same 8 keys as cmux panes, merged into
one newest-first queue, each key tagged by its source. cmux-only users see no
change; Orca is enabled automatically when an Orca runtime is reachable.

Non-goals: replacing or unifying cmux behind a shared interface (we generalize
only the few shared seams), an Orca LCD/usage surface, an Orca event stream
(none exists — see below), or any Orca-side mutation beyond focusing a worktree.

## Background: the Orca contract (grounded in the app source + CLI)

Orca is an Electron/TypeScript app (GitHub `stablyai/orca`, MIT) managing AI
coding agents across git worktrees. The integration is **poll-only** — Orca
exposes no event/watch/webhook CLI — and is driven by a single command.

### `orca worktree ps --json` — the whole snapshot

One call returns `result.worktrees[]`; each worktree carries everything the
board needs, so unlike cmux there is **no 3-way fuse and no events service**:

```jsonc
{
  "worktreeId": "<repoId>::<absPath>",   // stable item key
  "repo": "slovak-benchmarking-slides",  // → repo/short name
  "displayName": "new-slidev",           // → title
  "branch": "refs/heads/mrshu/new-slidev",
  "status": "permission",                // inactive|active|done|working|permission
  "unread": false,                       // MANUAL user flag — not auto-attention
  "isActive": true,
  "liveTerminalCount": 2,
  "hasAttachedPty": true,
  "lastOutputAt": 1782174656809,         // epoch ms
  "preview": "…last terminal screen…",
  "agents": [{
    "paneKey": "…",
    "state": "working",                  // working|blocked|waiting|done
    "agentType": "claude",               // claude|codex|gemini|… (explicit, no parsing)
    "prompt": "…",
    "lastAssistantMessage": "…",         // can be multi-KB; ignore for polling
    "toolName": "Bash",
    "interrupted": false,                // meaningful only when state==="done"
    "stateStartedAt": 1782172962917,     // → activitySince
    "updatedAt": 1782174267138
  }]
}
```

Canonical enums (from `src/shared/agent-status-types.ts`,
`src/shared/runtime-types.ts`):

- Agent `state`: `working | blocked | waiting | done`. `waiting`/`blocked` =
  needs a human (a Claude `PermissionRequest` or `AskUserQuestion` hook maps to
  `waiting`). `done` + `interrupted: true` = **stopped by the user**, distinct
  from a clean finish.
- Worktree `status`: `inactive | active | done | working | permission`,
  priority-merged across panes. **`permission` is the canonical "needs you now"
  flag** (reached only via a `waiting`/`blocked` agent).

`unread` is a **manual** "mark unread" flag, not auto-attention — we do **not**
key urgency off it. The renderer's auto amber-dot attention state is not exposed
by the CLI; we derive attention from `status` + `agents[].state` instead.

### Other CLI primitives

- **Offline gate:** `orca status --json` → `result.runtime.reachable` (and
  `result.app.running`). **Exit code is always 0**, even on logical errors —
  always parse the JSON `ok`/`error`, never `$?`. `ok:false` with
  `_meta.runtimeId: null` ⇒ runtime/connection problem.
- **Jump primitive:** there is **no** worktree-focus verb. Press =
  `open -a Orca` + resolve the worktree's terminal handle via
  `orca terminal list --worktree id:<worktreeId> --json` (each entry has
  `handle`, `worktreeId`, `lastOutputAt`; pick **max `lastOutputAt`**) →
  `orca terminal focus --terminal <handle> --json` (alias of `terminal switch`).
  Resolved lazily on key-press, not every poll.
- **No dismiss / mark-read primitive exists.** `worktree set` has no
  unread/read flag. Focusing a worktree in the UI is what clears its unread.

## Architecture

A new `OrcaService` mirrors `CmuxService`: poll on an interval, normalize to
`AttentionItem[]` tagged `source: "orca"`, push into the store. The store changes
from a single `allItems` array to **per-source slices merged on `recompute()`**.
The sort/triage/slot pipeline in `src/core/cmux/sort.ts` is already
source-agnostic (it ranks by `reason`/`activity`/`createdAt`) and is unchanged.
`src/core/cmux/*` internals, `CmuxEventsService`, the busy-CPU/`agentAliases`
machinery, and the entire CodexBar/LCD layer are untouched.

```
orca worktree ps --json ──▶ OrcaClient.listAttention() ──▶ AttentionItem[] (source:"orca")
                                                               │
cmux …                  ──▶ CmuxClient.listAttention()  ──▶ AttentionItem[] (source:"cmux")
                                                               ▼
                              Store: per-source slices ─ recompute() ─▶ merged sort/triage/slots ─▶ keys
```

### New modules (parallel to the cmux layer; do not reuse cmux files)

- `src/core/orca/client.ts` — `OrcaClient`: wraps the `orca` CLI. `listAttention()`
  (runs `worktree ps --json`, normalizes), `focus(worktreeId)` (terminal-list →
  pick handle → `terminal focus`), `reachable()` (`status --json`). Same
  bin-resolution/`AUGMENTED_PATH` pattern as `CmuxClient` (Stream Deck launches
  the plugin with a minimal PATH; resolve `orca` against
  `/Applications/Orca.app/Contents/Resources/bin`, `/usr/local/bin`,
  `/opt/homebrew/bin`, `~/.local/bin`). Pluggable `CommandRunner` for tests.
- `src/core/orca/normalize.ts` — pure `worktree ps` JSON → `AttentionItem[]`.
  Dependency-free, unit-tested headlessly (mirrors `cmux/normalize.ts`).
- `src/core/services/orcaService.ts` — `OrcaService`: poll loop with the same
  robustness rules as `CmuxService` (no overlapping polls; ≥2 consecutive
  failures before flipping offline; keep last good items on a transient miss).

## State mapping (Orca → muxboard `reason`/flags)

Per worktree, fold its `agents[]` (newest/most-urgent agent wins, matching
Orca's own priority merge):

| Orca signal | `reason` | flags / treatment |
| --- | --- | --- |
| `status: permission` (any agent `waiting`/`blocked`) | `blocked` | `needsInput: true` — amber, front-pinned |
| agent `done`, `interrupted: true` | `failed` | red — "stopped" |
| agent `done`, clean | `finished` | teal |
| `status: working` (no needs/done) | (n/a) | `activity: "working"`, `synthetic: true` — sinks to end |
| `status: active`/`inactive`, no live agent | — | not surfaced |

Field mapping: `agentType` → `AgentKind` (unknown agent strings → `unknown`);
`repo`/`displayName` → `repo`/`title`; `lastAssistantMessage` → `message`;
`stateStartedAt` → `activitySince`; `worktreeId` → the item id and workspace key;
`createdAt` = ISO of `stateStartedAt` (fallback `updatedAt`) for the newest-first
sort. Orca has no per-workspace color; Orca items render with no border
(`borderW = 0`, the existing no-color path) unless overridden by
failed/blocked/needs treatment.

Working-only worktrees become `synthetic` running items, reusing the existing
"listed at the end, no notification" path. Like cmux synthetics they are pressed
to focus the worktree directly.

## Identity, merge & dedup

`AttentionItem` gains a required `source: AttentionSource` (`"cmux" | "orca"`).
It is stamped in both normalizers and consumed in: focus/dismiss dispatch, the
render badge, and the dedup key. `dedupeNewestPerWorkspace` changes its key from
`workspaceId` to `${source}:${workspaceId}` so a cmux and an Orca item for the
same repo never collapse into one. The store recompute concatenates all source
slices, then runs the existing pipeline unchanged. No cross-source dedup: the
same repo open in both tools is genuinely two sessions and gets two keys
(distinguished by the source badge).

## Focus & long-press

Both tap and long-press on an Orca key **focus the worktree** — focusing is what
clears Orca's `unread` in-app, and there is no dismiss primitive to offer. (cmux
keeps its existing tap=open / long-press=dismiss behavior.) Dispatch routes by
`item.source` through a small per-source backend resolved on the runtime:

```ts
interface AttentionBackend {
  focus(item: AttentionItem): Promise<void>;
  dismiss(item: AttentionItem): Promise<void>; // Orca: same as focus
  bringToFront(): void;                          // cmux: open -a cmux; orca: open -a Orca
}
```

`attentionKey.ts` (`focus`/`dismiss`, the long-press arming at `onKeyDown`) and
`dialStrip.ts` ("jump to newest") select `runtime.backends[item.source]` instead
of the hard-wired `runtime.cmux.*`. The Orca backend's `focus` does the
terminal-list → handle → `terminal focus` jump. For Orca, the `onKeyDown`
long-press arming routes to the same focus (so a held Orca key still jumps);
since tap and long-press converge for Orca there is no separate dismiss path.

## Enablement & offline

**Auto-detect (default).** Config `enableOrca: "auto" | true | false` (default
`"auto"`). On `"auto"`, the plugin probes `orca status --json` at startup and on
a slow retry cadence; it constructs and starts `OrcaService` only when
`runtime.reachable`. cmux-only users never run the Orca poller. `true`/`false`
force it on/off.

**Per-source offline.** `AppState.cmuxOffline` generalizes to
`offline: Record<AttentionSource, boolean>`; each poller owns its own
`consecutiveFailures`. The blank-board offline tile
(`attentionKey.renderOne`, today gated on `cmuxOffline && slot===0 &&
items.length===0`) shows only when **every active source is offline and the
queue is empty**; `renderCmuxOffline()` generalizes to
`renderSourceOffline(label)`. A source that is merely disabled (not auto-started)
does not count as "offline".

## Render — the source badge

A small monochrome badge marks each key's source so cmux and Orca are
distinguishable at a glance. The Orca badge is the **real Orca logo**: the single
flat `<path>` from `Orca.app/.../resources/logo.svg` (byte-identical to
`onorca.dev/logo.svg`), `viewBox="0 0 318.60232 202.66667"`, recolored to the
key foreground. cmux gets a matching small cmux mark so a bare key is never
ambiguous. Both are drawn via a `sourceGlyphSvg(source)` helper modeled on
`providerIconSvg` (a translated/scaled `<g>` — the Stream Deck renderer cannot
nest `<svg>`), placed in a free key corner (bottom-right; the glyph chip is
top-left, age top-right). The orca mark is ~1.57:1 wide; scale to fit and center.

**Trademark note.** Orca's repo is MIT (code), which does not grant trademark
rights to the brand mark. Nominative use by a community plugin pointing at the
official app is normally fine; if the vendor objects, swap `sourceGlyphSvg("orca")`
for a generic glyph. This is a one-line, isolated change by design.

## Config

`MuxboardConfig` gains, alongside the cmux fields:

- `orcaBin: string` (default `"orca"`; resolved like `cmuxBin`).
- `orcaPollMs: number` (default mirrors `cmuxPollMs`, clamped).
- `enableOrca: "auto" | boolean` (default `"auto"`).

`resolveConfig` coerces/clamps each defensively; `DEFAULT_CONFIG` keeps the
out-of-box experience identical for cmux-only users. `plugin.ts` conditionally
constructs/starts the Orca client + service and registers its backend.

## Error handling

Every Orca call is best-effort, matching the cmux poller: a failed poll (CLI
missing, `ok:false`, bad JSON, timeout) increments `consecutiveFailures`, keeps
the last good Orca items, and flips that source offline only at ≥2. The focus
path catches and `showAlert()`s on failure (terminal-list empty, handle missing,
`terminal focus` error) without throwing into the key handler. A 10s exec ceiling
guards against a hung CLI wedging the loop. Auto-detect failures are silent
(Orca simply stays dormant).

## Testing

- `test/orca/normalize.test.ts` — fixtures covering the status × state matrix
  (`permission`/`done`-clean/`done`-interrupted/`working`/`active`) → expected
  `reason`/`activity`/`needsInput`/`synthetic`; agentType mapping incl. unknown;
  empty/`agents:[]` worktrees dropped; missing-field robustness.
- `test/orca/client.test.ts` — `OrcaClient` with an injected `CommandRunner`:
  `worktree ps` parse, focus handle-selection (max `lastOutputAt`, multi-terminal),
  `reachable()` true/false, `ok:false`-with-exit-0 handling.
- `test/store/merge.test.ts` — two sources push concurrently; per-source replace
  doesn't clobber the other; `${source}:${workspaceId}` dedup keeps both repos;
  triage order across merged sources; per-source offline.
- Headless preview fixture (`scripts/preview.ts`) showing a mixed cmux+Orca board
  with both badges, so `npm run preview` renders the new state.

## File-level change list

ADD: `src/core/orca/{client,normalize}.ts`, `src/core/services/orcaService.ts`,
`sourceGlyphSvg` + vendored orca/cmux marks in `src/core/render/`, the
`AttentionBackend` wiring on `Runtime`, Orca config fields, tests above.

CHANGE: `types.ts` (`AttentionSource`, required `source`, `offline` map);
`store.ts` (per-source slices, `setAttention(source, items, offline)`,
concat in `recompute`); `sort.ts` (dedup key → `${source}:${workspaceId}`);
`cmux/normalize.ts` (stamp `source:"cmux"`); `attentionKey.ts` + `dialStrip.ts`
(dispatch by `item.source`); `runtime.ts` (`bringCmuxToFront` → backend
`bringToFront`); `keyRender.ts` (badge); `plugin.ts` + `config.ts` (wire +
auto-detect).

LEAVE ALONE: all `src/core/cmux/*` parsing internals, `CmuxClient`,
`CmuxEventsService`, `workspaceStatus`, busy-CPU/`agentAliases`, the CodexBar/LCD
layer, the sort/triage/slot ranking logic.
