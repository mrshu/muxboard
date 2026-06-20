# Muxboard

A **Stream Deck+** plugin that turns the 8 keys into an at-a-glance queue of
[cmux](https://cmux.io) panes whose coding agents — **Claude Code, Codex, Pi**,
or any other — need your attention (finished, failed, blocked, or waiting for
input). The LCD touch strip visualizes **CodexBar** quota/limit telemetry.

![Muxboard dashboard](docs/images/dashboard.png)

Newest attention item is **key 1** (top-left); the queue fills left-to-right,
top-to-bottom:

```
1 2 3 4      key 1 = newest attention item
5 6 7 8      key 8 = 8th newest
```

Press a key to bring cmux to the foreground and jump straight to that
workspace/surface. Empty slots render muted. When cmux or CodexBar is
unreachable, the display degrades gracefully and the rest keeps working:

![Offline state](docs/images/dashboard-offline.png)

---

## How it works

| Surface | Shows | Source |
| --- | --- | --- |
| **8 keys** | Attention queue: agent glyph, status, repo, age | cmux, via the **bridge** |
| **LCD strip** (4×200×100) | Session / weekly quota, route health, spend | `codexbar serve` HTTP |
| **4 dials** | Scroll · filter · provider · refresh | local state |

> **Why a bridge?** cmux's control socket only trusts processes inside a cmux
> session (ancestry check; default `socketControlMode: cmuxOnly`). The Stream
> Deck app launches plugins via launchd, *outside* any session, so cmux rejects
> them with "broken pipe". The **bridge** is a tiny localhost HTTP server you run
> *inside* a cmux terminal; it runs the cmux CLI on the plugin's behalf and the
> plugin reaches it over TCP. See [Architecture](#architecture).

- **Keys** are sorted newest-first by the notification `created_at` and assigned
  to physical slots. Agent is read from the notification `title`; status is
  mapped from the structured `body` — **no terminal scraping**.
- **Pressing a key** runs `cmux open-notification --id <uuid>`, which focuses the
  workspace + surface and marks the row read (it does **not** dismiss it).
- **The LCD** polls CodexBar per provider and shows the session/weekly windows
  with reset countdowns, a route/health pill, and today's spend.

### Dials (Stream Deck+)

| Dial | Rotate | Press |
| --- | --- | --- |
| 1 · SESSION | Scroll the queue (when > 8 items) | Jump to newest item |
| 2 · WEEKLY | Cycle filter: all → claude → codex → pi | Reset filter to all |
| 3 · ROUTE | Cycle CodexBar provider | Open CodexBar source URL |
| 4 · SPEND | — | Force refresh both polls |

---

## Requirements

- **Node.js ≥ 20** (developed on v26).
- **cmux** on your `PATH` (or set `cmuxBin`). Verified against cmux 0.64.16. The
  **bridge** (`npm run dev` / `npm run bridge`) must run inside a cmux terminal.
- **CodexBar** for the LCD: run `codexbar serve --port 17777`. Muxboard defaults
  to **17777** (keeping CodexBar's own default 8080 free). Optional — the keys
  work without it.
- **Stream Deck+** hardware **and** the free
  [Elgato Stream Deck desktop app](https://www.elgato.com/stream-deck) to run the
  plugin on the device. The app is what launches the plugin process.

> You can review the full visuals and verify all transforms **without** the
> hardware or the desktop app — see _Headless preview_ below.

---

## Quick start

```bash
npm install
npm test          # unit tests over the core transforms
npm run validate  # prints the 8-key layout + LCD summary, asserts acceptance
npm run preview   # renders out/dashboard.png (+ dashboard-offline.png)
```

### Headless preview

`npm run preview` rasterizes the exact key + LCD SVGs from the test fixtures to
`out/*.png` via `@resvg/resvg-js`, so you can see precisely what the device will
show with no Stream Deck+ and no desktop app.

### Run on the device

1. Install and open the **Elgato Stream Deck** desktop app.
2. **Inside a cmux terminal**, run:
   ```bash
   npm run dev
   ```
   This builds + links the plugin, generates the device profile, starts CodexBar
   (background), and runs the **cmux bridge in the foreground** — leave it
   running. It must run inside cmux so the bridge has a valid cmux session.
3. That's it. The plugin auto-applies a **predefined Stream Deck+ profile**, so
   all 8 keys and 4 dials are populated automatically — no dragging. Keys fill
   from cmux (via the bridge), the LCD from CodexBar.

The first time the plugin switches to its profile, the Stream Deck app may ask
you to confirm installing it. For live plugin development, run `npm run watch`
in a second pane.

---

## The cmux notification contract

Muxboard is driven entirely by cmux notifications — agents make a pane "need
attention" by emitting one. cmux already does this for built-in agents; for
custom agents, emit a notification (e.g. from an agent hook) shaped like the
rows returned by `cmux list-notifications --json`:

```json
{
  "id": "015D0B50-…",            // uuid; used as the focus/open key
  "title": "Claude Code",         // agent → claude | codex | pi | unknown
  "subtitle": "",
  "body": "Claude is waiting for your input",   // status (see mapping)
  "is_read": true,
  "workspace_id": "6ECA42AE-…",   // required
  "surface_id": "4F5A8945-…",     // focused on press
  "tab_title": "RCJ Scoreboard",  // shown as the repo/short name
  "created_at": "2026-06-20T11:59:46Z"  // sort key, newest-first
}
```

**Agent** is matched from `title` (case-insensitive): contains `claude` →
`claude`, `codex` → `codex`, a `pi` word → `pi`, otherwise `unknown` (still
shown, just without a branded palette).

**Status** is mapped from `body`, strongest signal first:

| Status | Body contains (any) | Treatment |
| --- | --- | --- |
| `failed` | fail, failed, error, crashed, exception | strongest (red border) |
| `blocked` | permission, approve, blocked, denied, confirm | strong (amber) |
| `waiting` | waiting, awaiting, input, ready for, your turn | strong (yellow) |
| `finished` | done, finished, complete, ready | normal (teal) |
| `unknown` | anything else | muted |

Notes:

- Rows missing `id` or `workspace_id` are dropped (never fatal).
- `is_read` is **not** used as a filter — every listed notification is treated as
  needing attention. Pressing a key marks it read via `open-notification` but
  leaves it in the list.
- To emit one yourself: `cmux notify --title "Codex CLI" --body "Task failed: …"`
  (run inside the target workspace, or pass `--workspace`).

---

## CodexBar contract

Muxboard polls `codexbar serve` (default `http://127.0.0.1:17777`). It queries
each provider individually — `/usage?provider=all` returns nothing — and handles
both payload shapes CodexBar emits:

- **Codex** exposes `primary`/`secondary` windows at the top level.
- **Claude / others** nest them under `usage`.

Each window provides `usedPercent`, `resetsAt`, `windowMinutes`, and a
`resetDescription`; `primary` is the session (5h) and `secondary` the weekly (7d)
window. Today's spend comes from `/cost?provider=<p>`. A provider that returns an
`{ error }` object (e.g. an expired token) is shown as unavailable. Data older
than **2× the poll interval** is flagged `STALE`.

---

## Configuration

Stored in the plugin's global settings; all fields have safe defaults
(`src/config.ts`):

| Field | Default | Notes |
| --- | --- | --- |
| `cmuxBin` | `"cmux"` | Binary path/name (used by the bridge) |
| `cmuxBridgeUrl` | `"http://127.0.0.1:17779"` | Muxboard bridge base URL |
| `codexbarBaseUrl` | `"http://127.0.0.1:17777"` | `codexbar serve --port 17777` base URL |
| `codexbarProviders` | `["codex", "claude"]` | Polled + cycled by dial 3 |
| `cmuxPollMs` | `1500` | cmux poll interval |
| `codexbarPollMs` | `45000` | CodexBar poll interval |
| `enabledAgents` | all | Agents allowed onto the queue |

---

## Architecture

```
                  ┌─ cmux terminal (in-session) ─┐
  Stream Deck+    │  bridge.mjs  ── cmux CLI ──► cmux socket
   │ plugin ──TCP──► /notifications, /open       │
   └── TCP ──► codexbar serve (LCD usage)        │
                  └──────────────────────────────┘

src/
  plugin.ts          entry: connect, load config, start services, apply profile
  runtime.ts         shared store/clients/services + macOS foregrounding
  config.ts          defaults + defensive resolveConfig()
  core/              dependency-free, unit-tested, no SDK import
    types.ts
    cmux/            source (interface), client (CLI — used by the bridge),
                     bridgeClient (HTTP — used by the plugin), normalize, sort
    codexbar/        client (HTTP), normalize (dual-shape + error + cost)
    render/          palette, format, keyRender (SVG), lcdRender (SVG)
    services/        store (state + dial machines), cmux/codexbar poll loops
  actions/           attentionKey (8 keys), dialStrip (4 dials) — thin SDK glue
scripts/
  bridge.mjs         the cmux bridge (runs in-session; HTTP → cmux CLI)
  preview / validate / gen-icons / gen-profile / dev.sh
test/                fixtures + node:test suite
com.mrshu.muxboard.sdPlugin/   manifest, layouts, profile, imgs, built bin
```

### The cmux bridge

The plugin never spawns cmux itself (it can't — wrong process lineage). Instead
`scripts/bridge.mjs` runs inside a cmux terminal and exposes:

```
GET  /notifications          → cmux list-notifications --json
POST /open?id=<uuid>         → cmux open-notification --id <uuid>
POST /select-workspace?id=.. → cmux select-workspace --workspace <id>
GET  /health
```

The plugin's `CmuxBridgeClient` fetches from it over TCP and normalizes the same
way a direct CLI call would. Both `CmuxClient` (CLI) and `CmuxBridgeClient` (HTTP)
implement `CmuxSource`, so the polling service is agnostic to the transport.

**Alternative considered:** cmux's `socketControlMode: automation` is the
documented way to allow external processes (the
[gonzaloserrano/streamdeck-cmux](https://github.com/gonzaloserrano/streamdeck-cmux)
plugin uses it). On the tested cmux build + macOS 15.7 it had no effect
(`access_mode` stayed `cmuxOnly`; see upstream issues
[#1864](https://github.com/manaflow-ai/cmux/issues/1864),
[#3282](https://github.com/manaflow-ai/cmux/issues/3282)). The in-session bridge
needs **no cmux config change** and works under the default `cmuxOnly`, so it's
the more robust choice. If a future cmux fixes `automation` mode, the plugin
could talk to the socket directly and the bridge becomes optional.

Rendering is **SVG-first**: Stream Deck's `setImage` accepts SVG data-URIs, so
keys and LCD segments are plain strings — no native canvas dependency and fully
testable. Each action caches the last SVG per instance to debounce redundant
draws (anti-flicker). Polls never overlap, and last-good data is retained on
failure so a transient outage never blanks the display.

---

## Testing

```bash
npm test        # 30 unit tests: normalization, slotting, dual-shape codexbar,
                # SVG structure, store dial machines, service offline retention
npm run validate
npm run typecheck
```

---

## Troubleshooting

- **Plugin won't start / crash-loops on first install.** The Stream Deck app
  runs Node plugins with its own managed Node.js runtime, downloaded on demand.
  If it's missing (`NodeJS/manifest.json not found` in
  `~/Library/Logs/ElgatoStreamDeck/StreamDeck.log`), **fully quit and relaunch
  the Stream Deck app** so it fetches the runtime, then restart the plugin.
- **`require is not defined` / exit code 1.** The bundle must be CommonJS with a
  `.cjs` extension (this repo's `package.json` is `"type":"module"`). `npm run
  build` already emits `bin/plugin.cjs`; the manifest's `CodePath` points at it.
- **Changed the manifest? Re-link.** A plugin restart does not re-read the
  manifest. Run `npx streamdeck link com.mrshu.muxboard.sdPlugin` again (or
  restart the Stream Deck app) after editing it.
- **LCD shows "CodexBar off".** Ensure `codexbar serve --port 17777` is running
  and that `codexbarBaseUrl` matches the port.
- **Keys are blank / "cmux offline".** The bridge must run **inside a cmux
  terminal**. If it logs `broken pipe`, it was started outside a cmux session
  (or got reparented to launchd) — cmux rejects it. Run `npm run dev` (or
  `npm run bridge`) in a cmux pane and leave it running; check
  `curl 127.0.0.1:17779/health`.
- **Profile didn't auto-apply.** The Stream Deck app prompts once to install a
  bundled profile; accept it. Editing the manifest needs a re-link.

## Privacy & non-goals

- **Localhost only.** The sole network call is to CodexBar on `127.0.0.1`.
- **No terminal scraping** — only cmux's structured notification fields.
- **No destructive actions** — Muxboard never dismisses cmux notifications, runs
  commands inside agents, or sends approve/deny input. It reads + focuses.
- **No cloud, no database** beyond plugin settings and an in-memory cache.

MVP intentionally excludes: command execution, approve/deny buttons, non-Stream
Deck+ devices.

## License

MIT
