# Muxboard MVP — Design

**Status:** approved for implementation
**Date:** 2026-06-20
**Target device:** Elgato Stream Deck+ (8 LCD keys, 4 dials, 800×100 touch strip = 4×200×100 segments)

## Goal

A Stream Deck+ plugin that surfaces which **cmux** panes need attention because a
coding agent (Claude Code, Codex, Pi, …) running there has **finished / failed /
blocked / is waiting for input**. The 8 keys are an at-a-glance attention queue;
the LCD/touch strip visualizes **CodexBar** quota/limit telemetry only.

## Verified environment (ground truth, 2026-06-20)

These are the **actual** contracts on the dev machine, which differ from the
original brief's assumptions. The design is built to the real contracts.

### cmux 0.64.16

`cmux list-notifications --json` returns an array of:

```json
{
  "id": "015D0B50-...",
  "title": "Claude Code",
  "subtitle": "",
  "body": "Claude is waiting for your input",
  "is_read": true,
  "workspace_id": "6ECA42AE-...",
  "surface_id": "4F5A8945-...",
  "tab_title": "RCJ Scoreboard",
  "created_at": "2026-06-20T11:59:46Z"
}
```

Reality vs brief:

- **No** `reason`, `repo`, `branch`, `paneId`, or `updatedAt` fields exist.
  - `agent` ← derived from `title`.
  - `reason` ← mapped from `body` (cmux's own **structured** notification text;
    this is *not* terminal scraping).
  - `repo` / short name ← `tab_title`.
  - sort key ← `created_at` (no `updatedAt` available).
- `is_read` is **not** a usable "needs attention" filter — every live
  notification is `is_read:true` yet clearly needs attention. We treat **every
  listed notification** as an attention item.
- `cmux open-notification --id <uuid>` = *"Focus the notification's workspace and
  surface, then mark the row read."* This is the press primitive. It marks
  **read** but does **not** clear/dismiss the row, so it satisfies "do not clear
  the cmux notification." Fallback path: `select-workspace` + `focus-pane` +
  `focus-surface`/`focus-panel`.

### CodexBar

`codexbar serve` listens on **port 8080** (not 17777). `/usage?provider=all`
returns **empty** — providers must be queried individually
(`codex`, `claude`, `minimax`, `kimi`). `/cost?provider=<p>` returns daily spend.
`/health` → `{"status":"ok"}`.

Two payload shapes for the normalized usage window:

- **Codex:** `primary` / `secondary` / `tertiary` / `identity` at the **top
  level** of the object (the `usage` key holds credits, not windows).
- **Claude / MiniMax:** the same fields are nested under **`usage`**.

Each window object:
`{ usedPercent, resetsAt?, windowMinutes, resetDescription }`
where `primary` = session (windowMinutes 300 / 5h), `secondary` = weekly
(windowMinutes 10080 / 7d), `usedPercent` = % **used** (remaining = 100−used).

Error shape (e.g. expired token):
`{ "error": { "message", "code", "kind" }, "provider", "source" }` — handled as
an unavailable provider.

Default config: base URL `http://127.0.0.1:8080`, configurable.

## Attention model

Normalized internal type:

```ts
interface AttentionItem {
  id: string;
  agent: "claude" | "codex" | "pi" | "unknown";
  workspaceId: string;
  surfaceId?: string;
  repo?: string;       // from tab_title
  title: string;       // human label (tab_title or body)
  reason: "finished" | "failed" | "blocked" | "waiting" | "unknown";
  body: string;
  createdAt: string;   // ISO
  ageSeconds: number;  // computed at render time
}
```

**Agent detection** (from `title`, case-insensitive):
`claude` if title contains "claude"; `codex` if "codex"; `pi` if it is exactly
"pi"/"π" or contains "pi-"/" pi"; else `unknown`.

**Reason mapping** (from `body`, ordered, case-insensitive):
1. `failed` ← "failed" | "error" | "crashed".
2. `blocked` ← "permission" | "approve" | "blocked" | "denied".
3. `waiting` ← "waiting" | "input" | "awaiting" | "ready for".
4. `finished` ← "done" | "finished" | "complete".
5. `unknown` ← anything else.

**Sort & slotting:** all items, newest-first by `createdAt`; `sorted[0]` → slot 0
(physical key 1) … `sorted[7]` → slot 7 (key 8). A scroll `offset` (dial 1)
shifts the visible window when > 8 items. Empty slots render muted/blank.

## CodexBar model

```ts
interface UsageWindow {
  usedPercent: number;      // 0..100 used
  remainingPercent: number; // 100 - used
  resetsAt?: string;        // ISO
  resetDescription?: string;
  windowMinutes?: number;
}
interface ProviderUsage {
  provider: string;          // "codex" | "claude" | ...
  account?: string;
  session?: UsageWindow;     // primary
  weekly?: UsageWindow;      // secondary
  costTodayEur?: number;     // from /cost (optional)
  updatedAt?: string;
  ok: boolean;               // false if {error} or unreachable
  error?: string;
}
```

Normalizer reads `obj.usage?.primary ? obj.usage : obj` to unify the two shapes.

## Architecture

```
src/
  plugin.ts                 entry: register actions, start services
  config.ts                 schema + defaults + load/merge (global settings)
  core/
    types.ts                AttentionItem, ProviderUsage, AppState
    cmux/
      client.ts             exec cmux (list-notifications, open-notification, focus*)
      normalize.ts          raw notification -> AttentionItem
      sort.ts               sort + slot assignment + offset windowing
    codexbar/
      client.ts             fetch /usage?provider, /cost, /health
      normalize.ts          raw -> ProviderUsage (dual-shape + error)
    render/
      palette.ts            agent + reason colors
      format.ts             age "2m"/"1h", countdown, percent
      keyRender.ts          AttentionItem|empty -> SVG string (72x72-ish)
      lcdRender.ts          ProviderUsage -> 4 segment SVGs (200x100)
    services/
      store.ts              in-memory AppState + subscribe/emit
      cmuxService.ts        poll 1.5s, debounce, cache, update store
      codexbarService.ts    poll 45s, last-good cache, stale >2x interval
  actions/
    attentionKey.ts         Keypad action; slot from coordinates; press -> focus
    dialStrip.ts            Encoder action ×4; segment from column; dial behaviors
test/
  fixtures/                 cmux-notifications.json, codexbar-usage-*.json
  *.test.ts                 normalize, sort/slot, codexbar dual-shape, render snapshots
scripts/
  preview.ts                render fixtures -> out/*.png via @resvg/resvg-js
*.sdPlugin/                 manifest.json, profile, compiled bin/, imgs
```

### Rendering: SVG-first

Stream Deck `setImage` accepts SVG data-URIs, so all rendering produces **SVG
strings** — no native canvas dependency, fully unit-testable by asserting on
structure. The preview script rasterizes SVG→PNG with `@resvg/resvg-js`
(prebuilt, dev-only) so humans can verify visuals without a device.

### Stream Deck mapping

- One **Keypad** action `com.mrshu.muxboard.attention`, placed on all 8 keys.
  Each instance computes `slot = row*4 + column` from its coordinates → physical
  order `1 2 3 4 / 5 6 7 8`.
- One **Encoder** action `com.mrshu.muxboard.dial` ×4; `segment = column` (0..3).
- A bundled **profile** auto-populates all keys + dials so ordering works on
  install without manual placement.

### Key visuals

Each populated key SVG shows: agent glyph (C / X / π) + agent palette, a reason
band (failed = strongest red; blocked/waiting = strong amber; finished = normal;
stale/unknown = muted grey), repo/workspace short name, age (`2m`/`1h`), and a
small branch/pane hint line. Empty slots render a muted blank tile.

### LCD segments (4 × 200×100)

1. Codex **session**: percent + bar + reset countdown.
2. Codex **weekly**: percent + bar + reset countdown.
3. Route/health: `OK / LOW / CAP / STALE`.
4. Cost/spend: `€X today` or fallback `stale age` / `error` / `CodexBar off`.

Stale indicator when data older than 2× refresh interval; clear "CodexBar off"
state when serve is unreachable — **cmux keys keep working regardless**.

### Dials (MVP)

- D1 rotate: scroll attention offset (when > 8). Press: jump to newest item.
- D2 rotate: cycle filter all → claude → codex → pi. Press: reset filter.
- D3 rotate: cycle CodexBar provider. Press: open CodexBar source if possible.
- D4 press: force refresh both polls.

### Press flow

1. Bring cmux to foreground (`open -a cmux` / `open -b <bundle>`).
2. `cmux open-notification --id <uuid>` (selects workspace + focuses surface).
   Fallback: `select-workspace` → `focus-pane` → `focus-surface`/`focus-panel`.
3. Record local `lastOpened[id]` timestamp. Never dismiss/clear cmux state.

## Config (global plugin settings)

```ts
{
  cmuxBin: "cmux",
  codexbarBaseUrl: "http://127.0.0.1:8080",
  codexbarProviders: ["codex", "claude"],
  cmuxPollMs: 1500,
  codexbarPollMs: 45000,
  enabledAgents: ["claude", "codex", "pi", "unknown"]
}
```

Local cache only: last-good CodexBar payload, last rendered cmux state.

## Error handling

- cmux CLI missing / nonzero exit / bad JSON → keep last good state, log, render
  a single muted "cmux unavailable" hint on key 1; never crash the poll loop.
- CodexBar unreachable / `{error}` / stale → offline/stale LCD; keys unaffected.
- Schema validation on both feeds (lightweight zod-style guards); malformed rows
  are dropped, not fatal.

## Testing & acceptance

Unit tests over fixtures cover: agent/reason mapping, newest-first slotting to
physical `1 2 3 4 / 5 6 7 8`, offset windowing, empty-slot rendering, CodexBar
dual-shape + error normalization, and render snapshots (SVG contains expected
glyph/percent/age). `scripts/preview.ts` renders fixtures to `out/*.png`.

Maps to the 10 acceptance criteria: mocked notifications → correct physical
order (1); press → `open-notification`/focus calls (2); empty slots muted (3);
agent color/icon visible (4); LCD session+weekly+countdowns (5); CodexBar-off
state with working keys (6); no scraping (7 — structured fields only); no
destructive actions (8); localhost-only network (9); README documents the cmux
notification contract agents should emit (10).

## Non-goals (MVP)

No command execution in agents, no approve/deny buttons, no terminal scraping,
no cloud, no DB beyond plugin settings/cache, no non-Stream Deck+ devices.

## Decisions locked

- Plugin UUID/author: **com.mrshu.muxboard**.
- CodexBar default: **http://127.0.0.1:8080**, providers queried individually.
- Verification: headless PNG preview harness **and** device install path.
- Rendering: **SVG-first**, rasterized to PNG only for preview.
