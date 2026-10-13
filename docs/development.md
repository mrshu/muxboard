# Development guide

[Back to the README](../README.md)

Use Node.js ≥ 22 for development and tests (CI uses Node 22). The packaged
plugin runs on the Stream Deck app's managed Node 20 runtime. Start with
[Build from source](../README.md#build-from-source).

## Architecture

```
  Stream Deck+ plugin ── spawns ──► cmux CLI ──► cmux socket (automation mode)
        ├── CLI ──► Orca worktrees (attention)
        ├── CLI ──► Herdr local sessions + saved SSH machines (attention)
        └── TCP ──► codexbar serve (LCD usage)

src/
  plugin.ts          entry: connect, load config, start services
  runtime.ts         shared store/services/focus-backends + macOS foregrounding
  config.ts          defaults + defensive resolveConfig()
  core/              dependency-free, unit-tested, no SDK import
    types.ts
    cmux/            client (CLI wrapper), normalize (agent/reason), sort,
                     eventStatus (live state from the event stream + CPU)
    orca/            worktree snapshot normalization + terminal focus
    herdr/           snapshots, terminal identity, existing-host mapping + focus
    codexbar/        client (HTTP), normalize (dual-shape + error + cost)
    render/          palette, format, keyRender (SVG), lcdRender (SVG),
                     nerdGlyphs (vendored Nerd Font outlines for title icons)
    services/        store, cmux/orca/herdr/codexbar polls, cmuxEvents (event stream)
  actions/           attentionKey (8 keys), dialStrip (4 dials): thin SDK glue
scripts/             preview / validate / gen-icons / gen-nerd-glyphs / install-profile / dev.sh
test/                fixtures + node:test suite
com.mrshu.muxboard.sdPlugin/   manifest, layouts, imgs, built bin
```

### Orca agent state

The Orca source derives attention from a worktree's primary agent `state`,
rather than its top-level `status`. Worktree status reports terminal liveness
(PTY alive → `active`), so an agent waiting on a question or a finished unread
result can still belong to an active worktree. Muxboard uses the agent lifecycle
and worktree unread flag to distinguish those cases.

## The device profile

`scripts/install-profile.mjs` writes a Muxboard profile straight into the Stream
Deck app's `ProfilesV3` store (the app's own V3 format, keyed to the connected
Stream Deck+'s device id), placing the Attention Slot action on all 8 keys and
the Muxboard Dial on all 4 dials. Run it with the app closed
(`npm run install-profile`). The app picks it up on next launch and you select it
from the profile dropdown.

This deliberately bypasses the app's profile importer, which rejects
programmatically-built `.streamDeckProfile` archives as "content corrupted" on
recent macOS builds (confirmed across clean/stored zips and deterministic UUIDs).
Elgato's only supported way to produce an importable profile is to build it in the
app UI and _Export_ it, so we skip import entirely and write the store format the
app itself uses.

Rendering is SVG-first: Stream Deck's `setImage` accepts SVG data-URIs, so keys
and LCD segments are plain strings, with no native canvas dependency and fully
testable. Each action caches the last SVG per instance to debounce redundant
draws (anti-flicker). Polls never overlap, and last-good data is retained on
failure so a transient outage never blanks the display.

## Configuration overrides

The plugin reads Stream Deck global settings once when it connects. There is
currently no settings editor in the property inspector. For a source build,
adjust the fallbacks in [src/config.ts](../src/config.ts). Most fields use
`DEFAULT_CONFIG`. Source enablement falls back to `"auto"` in `coerceEnableOrca`,
while Herdr allow-lists and machine inclusion fall back to `[]` and `true`
inside `resolveConfig`. For those fields, also change the matching resolver
fallback because editing `DEFAULT_CONFIG` alone is insufficient. Rebuild with
`npm run build` and fully quit and reopen Stream Deck to reload the plugin.
Previously stored global settings override these fallbacks.

## Development watcher

`npm run dev` builds and links the plugin, starts a background CodexBar server
if needed, and keeps watching for code changes. Use another terminal for
`npm run install-profile`, or stop the watcher with Ctrl-C first. The watcher
starts CodexBar without launchd supervision. Use the keep-alive installer in
[CodexBar support](../README.md#codexbar-support) for persistent use. Fully quit
and reopen Stream Deck if the CLI's plugin restart does not load a rebuilt
bundle. Manifest changes may also require re-linking.

## Testing

```bash
npm test        # Unit tests: normalization, slotting, dual-shape codexbar,
                # SVG structure, store dial machines, service offline retention
npm run validate
npm run typecheck
npm run test:herdr:e2e  # Real Herdr CLI/server integration in isolated sessions
npm run e2e:streamdeck # Built plugin + real SDK with simulated device/services
```

The Herdr end-to-end harness requires Herdr ≥ 0.9.3 on PATH (or `HERDR_BIN`),
creates only uniquely named `muxboard-e2e-*` sessions, and removes those sessions
in cleanup. It does not change the default session or existing user sessions.

The Stream Deck suite runs the built plugin against a real SDK WebSocket peer
with controlled CLI and HTTP fixtures: 49 scenarios and 103 assertions cover
rendering, source and agent filters, source routing, existing-host focus, and
completion acknowledgement across plugin restarts and tab-wide native seen
changes. It simulates device hardware and services. It does not connect to live
SSH machines or use physical keys.

## Plugin troubleshooting

- **`require is not defined` / exit code 1:** the bundle must be CommonJS with
  a `.cjs` extension because the package uses `"type": "module"`. `npm run build`
  emits `bin/plugin.cjs`. The manifest's `CodePath` points at that file.
- **Manifest changes do not appear:** run
  `npx streamdeck link com.mrshu.muxboard.sdPlugin` again and fully quit and
  reopen Stream Deck. A plugin restart alone does not re-read the manifest.
