# Muxboard: a Stream Deck+ dashboard for AI coding agents

> Your [cmux](https://cmux.com/), [Orca](https://onorca.dev), and
> [Herdr](https://herdr.dev) coding agents on the keys, with CodexBar quotas,
> spend, and credits on the LCD.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)
![Stream Deck+](https://img.shields.io/badge/device-Stream%20Deck%2B-black.svg)
![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A5%2020-43853d.svg)

![Muxboard dashboard](docs/images/dashboard.png)

*Each key shows the agent's icon at the top left and its source badge at the
bottom right. A `?` in place of the age means Muxboard does not know yet how
long the agent has been in its current state.*

Muxboard turns the 8 keys of an Elgato Stream Deck+ into a shared queue of
coding agents (Claude Code, Codex, Pi, [OMP](https://github.com/can1357/oh-my-pi),
or any other) running in [cmux](https://cmux.com/) panes,
[Orca](https://onorca.dev) worktrees, and [Herdr](https://herdr.dev) sessions.
A key shows the agent's state (working, waiting, blocked, failed, or an unread
result). It also shows how long the agent has been in that state and where it
runs. Agents that need your attention come first. Pressing a key switches to
the existing workspace or pane. Muxboard detects Orca and Herdr automatically,
including named Herdr sessions and saved SSH machines.

The LCD touch strip shows usage for every provider you enable in CodexBar, such
as Codex, Claude, MiniMax, Kimi, CommandCode, and Perplexity. You get quotas with
reset countdowns and pace, today's spend and tokens when CodexBar has them, and
credit balances.

[Install](#install) · [Controls](#how-it-works) · [Sources](#sources) ·
[Configuration](#configuration) · [Troubleshooting](#troubleshooting) ·
[Build from source](#build-from-source)

## Install

You need macOS, Node.js ≥ 20, a Stream Deck+, the
[Elgato Stream Deck app](https://www.elgato.com/stream-deck), and at least one
agent source: cmux, Orca, or Herdr. CodexBar is only needed for the LCD.

The packaged [v0.2.0 release](https://github.com/mrshu/muxboard/releases/tag/v0.2.0)
supports cmux, Orca, Herdr, and all the controls described here. To change the
plugin itself, [build from source](#build-from-source).

Connect your device and open Stream Deck once, so the app knows about it. Then
install the latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/mrshu/muxboard/main/scripts/setup.sh | bash
```

The installer asks you to confirm the plugin package, installs the bundled
profile for the 8 keys and 4 dials, and checks cmux's automation mode if cmux is
installed. When it finishes, pick **Muxboard** in the Stream Deck profile
dropdown. If the profile did not install, see [Troubleshooting](#troubleshooting).

## How it works

| Surface | Shows | Source |
| --- | --- | --- |
| 8 keys | Agent, status, workspace, age, and source badge | [cmux](#cmux-support), [Orca](#orca-support), [Herdr](#herdr-support) |
| LCD touch strip | Quotas, resets, pace, spend, tokens, and credits | [CodexBar](#codexbar-support) |
| 4 dials | Queue scrolling, agent/source filters, quota view, refresh | See [Dials](#dials-stream-deck) |

The keys fill left to right, top to bottom. The most urgent agents come first,
in this order: failed, asking for permission, needing input, stalled, other
waiting agents and results, and finally agents that are working. Within each
group, the newest come first.

```text
1 2 3 4      key 1 = first item in the queue
5 6 7 8      key 8 = eighth item, or the "+N more" key
```

When more than eight agents match, the last key turns into **+N more**. Tap it
to see the next page, and tap **↑ top** to go back. You can also scroll with
dial 1. Unused keys stay dark. The **Decisions** view shows only failures,
permission requests, and agents that asked for input.

- Tapping a key takes you to the agent. For cmux, it opens the workspace and
  surface of the notification. For Orca, it selects the worktree's terminal.
  For Herdr, it switches to the window the session already runs in (a
  terminal, Zellij, tmux, or cmux) and focuses the agent, without opening a new
  terminal. Every Herdr agent gets its own key, even when several share a
  workspace.
- Holding a key for about 0.6 seconds snoozes it for five minutes. A ✓ shows
  while you hold the key, and releasing it has no further effect. Muxboard does
  not change the notification, so the key returns if the agent still needs you.
  Keys for working agents cannot be snoozed.
- Key titles keep the icons agents put in them, such as OMP's task icons.
  Muxboard draws these icons itself, so they show up without a Nerd Font
  installed.
- The LCD has one segment per CodexBar provider. Muxboard reads the list from
  CodexBar, so any provider you enable there shows up. Each segment shows the
  provider name in CodexBar's brand color, the 5h session (`S`) and weekly
  (`W`) gauges with their reset times, and today's spend and tokens when
  CodexBar has them. A provider with only a weekly limit, such as Codex, shows
  just the `W` row. When Claude has no 5h session, its segment shows the weekly
  gauge and the weekly limit for Fable (`F`) instead. MiniMax adds its 5h prompt
  count at the bottom, as a small `5h` tag and the number of prompts used (for
  example **49** / 100 prompts). CommandCode can show
  its monthly grant next to its rolling quotas. Credit-only accounts and
  Perplexity show one credit gauge with the amount spent and the allowance.
  Four providers fit at once, and dial 4 scrolls through the rest.
- Each gauge also has a **pace** marker. It compares how much of the quota you
  have used with how much of the window has passed. If you are under pace, a
  faded extension of the bar shows where you would be at an even rate. If you
  are over pace, a coral cap marks how far over pace you are. The number next to
  the gauge is the percentage left. Turn dial 3 to show the pace difference
  instead. A green `+12%` means you have quota to spare. A coral `−8%` means you
  are using it too fast.

### Dials (Stream Deck+)

| Dial | Turn | Short press / LCD tap | Hold (~0.6s) |
| --- | --- | --- | --- |
| 1 | Scroll queue (> 8 items) | Focus first visible item | Same as press |
| 2 | Cycle agent type | Clear both filters | Cycle source |
| 3 | Remaining % ↔ pace | Queue ↔ Decisions | Open CodexBar `/usage` |
| 4 | Scroll providers (> 4) | Refresh sources and quota | Same as press |

Dial 2 cycles the agent type through **All → Claude → Codex → OMP → Pi**.
Holding it cycles the source through **All → cmux → Orca → Herdr**, one step
per hold. With four or fewer providers, turning dial 4 does nothing.

The two filters combine. For example, select Claude, then hold dial 2 until
Herdr is selected to see only Claude agents running in Herdr. While a source is
selected, the keys show **CMX**, **ORC**, or **HDR**, and the Decisions view
shows **C DEC**, **O DEC**, or **H DEC**. If nothing matches, the empty keys
name the selected source. If that source is offline and Muxboard has nothing
cached for it, the keys say so. A short press or a touch on dial 2 clears both
filters.

When cmux, Orca, Herdr, or CodexBar stops responding, Muxboard keeps showing the
last data it received, and the other sources keep working.

<details>
<summary>Offline dashboard preview</summary>

![Offline state](docs/images/dashboard-offline.png)

</details>

## Requirements

- **Device:** a Stream Deck+ and the Elgato Stream Deck desktop app, which
  starts the plugin. The installer needs Node.js ≥ 20. Development and tests
  need Node.js ≥ 22.
- **Agent sources:** at least one of cmux, Orca, or Herdr running, with its CLI
  (`cmux`, `orca`, or `herdr`) on `PATH`. Orca must answer `orca status`. Herdr
  needs a running local session or an enabled saved SSH machine.
- **cmux:** set Settings → Automation → Socket Control Mode to **Automation**,
  then fully quit and relaunch cmux. `cmux capabilities | grep access_mode`
  should then show `automation`. For live agent state, install the agent hooks
  described in [cmux support](#cmux-support).
- **Herdr focus:** keep a Herdr client attached to the session or saved machine
  you want to reach. macOS must allow Muxboard to inspect and raise windows
  through System Events. See [focus permissions](docs/herdr.md#macos-focus-permissions).
- **LCD:** install CodexBar and keep its HTTP server running on port 17777.
  The keys work without it. See [CodexBar support](#codexbar-support).

## Sources

### cmux support

Muxboard combines `cmux list-notifications --json` with workspace status, agent
hooks, and process activity. Each workspace gets one key. A notification you
have already seen stays on the board at lower urgency, and clearing
notifications in cmux removes the key. Agents that are working can appear even
without a notification.

Turn on cmux automation mode as described in [Requirements](#requirements).
For accurate live state, use cmux's Claude wrapper, or `cmux hooks setup` for
other agents. OMP needs `cmux hooks omp install` (cmux ≥ 0.64.17). If Claude
keys stay stale while Codex keys update, see the
[hook troubleshooting guide](docs/cmux.md#troubleshooting-agent-hooks).

The [cmux integration guide](docs/cmux.md) covers notification fields, how
agents are identified, where state and age come from, and automation details.

### Orca support

Muxboard polls `orca worktree ps --json` and shows one key per worktree.
`waiting` and `blocked` agents show as needing input, and `working` agents go to
the end. A `done` agent shows a finished result (or a failure if it was
interrupted) only while the worktree is **unread**, so results you have seen do
not linger. The Orca mark on each key tells it apart from cmux and Herdr keys.

Muxboard starts polling Orca when `orca status` answers. The `enableOrca`,
`orcaBin`, and `orcaPollMs` settings control this, the binary path, and how often
it polls. See [Configuration](#configuration).

Pressing an Orca key brings Orca to the front and jumps to the worktree's most
recent terminal (`orca terminal focus`). Holding the key snoozes it for five
minutes without changing Orca's unread state. For how Orca's state fields are
read, see [Orca agent state](docs/development.md#orca-agent-state).

### Herdr support

Muxboard finds all running local sessions, including named ones, and all
enabled saved SSH machines. Each terminal that needs you or is working gets
its own key, even when several agents share a workspace. An **H** badge and a
machine/session label mark these keys.

`working` agents go to the end, `blocked` agents show **NEEDS YOU**, and `done`
agents show a result you have not seen yet. Idle agents you have already seen
are left out. A finished result stays on its key until you open that key, and
looking at another agent in the same workspace does not clear it. Agents that
are already idle when Muxboard starts count as seen, even on servers that keep
`completion_seq`.

Pressing a key switches to the window Herdr already runs in (a terminal,
Zellij, tmux, or cmux) and focuses the agent. Muxboard finds the app that owns
the session instead of assuming a particular terminal. For a remote machine, a
client must already be attached to the matching saved machine. If Muxboard
cannot find exactly one matching window, the key shows an alert and the item
stays on the board.

Remote machines refresh every 15 seconds by default, and keep their last keys
if a refresh fails. Muxboard does not start stopped sessions or ask for SSH
passwords. It works with Herdr 0.9.0 servers without restarting existing
sessions, and the integration tests run against Herdr 0.9.3.

The [Herdr integration guide](docs/herdr.md) covers session and machine
allow-lists, completion history, age tracking, host discovery, and
compatibility.

### CodexBar support

The LCD reads the list of enabled providers from `codexbar serve`, so it is not
limited to Codex and Claude. [How it works](#how-it-works) describes what each
segment shows.

Keep the server running on port **17777** with the launchd installer. It starts
the server at login and restarts it if it crashes:

```bash
curl -fsSL https://raw.githubusercontent.com/mrshu/muxboard/main/scripts/install-codexbar-agent.sh | bash
```

The packaged installer offers this step when CodexBar is installed. From a
checkout, run `bash scripts/install-codexbar-agent.sh`. To use another port, set
`CODEXBAR_PORT` and change `codexbarBaseUrl` to match. To remove the agent, run
the same script with `--uninstall`.

The [CodexBar integration guide](docs/codexbar.md) covers provider payloads,
credit pools, expired logins, and rate limits.

## Configuration

The settings below have their defaults in [src/config.ts](src/config.ts). The
Stream Deck property inspector has no settings editor yet, so standard installs
use the defaults. In a source build, you can
[change the defaults and rebuild](docs/development.md#configuration-overrides).
Global settings stored by Stream Deck override the defaults and are read when
the plugin starts. Poll intervals and timeouts are in milliseconds.

| Field | Default | Notes |
| --- | --- | --- |
| `cmuxBin` | `"cmux"` | Binary path or name (spawned directly) |
| `codexbarBaseUrl` | `"http://127.0.0.1:17777"` | `codexbar serve --port 17777` base URL |
| `codexbarProviders` | `[]` | Optional allow-list/order. Empty = auto-discover all |
| `cmuxPollMs` | `1500` | cmux poll interval |
| `codexbarPollMs` | `45000` | CodexBar poll interval |
| `codexbarTimeoutMs` | `30000` | Per-request HTTP timeout |
| `agentAliases` | `{}` | Manual override (name substring → agent). Process detection is primary |
| `busyCpuPercent` | `40` | Workspace CPU% (from `cmux top`) at/above which a running command counts as "working" |
| `enableOrca` / `enableHerdr` | `"auto"` | Start each optional source when reachable. `true` forces polling, `false` disables it |
| `orcaBin` / `herdrBin` | `"orca"` / `"herdr"` | CLI binary path or name |
| `orcaPollMs` / `herdrPollMs` | `1500` | Optional source poll interval |
| `herdrSessions` | `[]` | Exact local session allow-list. Empty includes all running sessions |
| `herdrIncludeMachines` | `true` | Include enabled saved SSH machine profiles |
| `herdrMachines` | `[]` | Saved profile id/label allow-list. Empty includes enabled profiles |
| `herdrMachinePollMs` | `15000` | Separate, slower polling cadence for SSH machines |

## Troubleshooting

- An agent is missing. Short-press dial 2 to clear the source and agent
  filters, switch to the Queue view with dial 3, and check the **+N more** key.
  A cmux agent needs a notification or a live working signal. An Orca agent
  shows up from its primary agent's state or an unread result. A Herdr agent
  shows up while it is working, blocked, or has an unread result. Muxboard
  hides idle Herdr agents you have already seen.
- Herdr keys are missing. Run `herdr session list --json` to see the running
  local sessions, and check `enableHerdr` and the `herdrSessions` allow-list.
  Stopped sessions do not show up. For a saved machine, check that its profile
  is enabled and listed in `herdrMachines`. Log in to it in a terminal with
  `herdr machine reconnect <profile-id>`.
- A Herdr key shows an alert and does not switch to the agent. Keep a Herdr
  client attached in a terminal, Zellij, tmux, or cmux. If more than one window
  matches, Muxboard does nothing. For a remote machine, select the matching
  saved machine in that client. You do not need to restart a running session.
  For Herdr 0.9.0 servers, Muxboard focuses the tab first and then the agent
  pane. If the logs show a macOS permission error, see
  [focus permissions](docs/herdr.md#macos-focus-permissions).
- The plugin does not start, or crashes after the first install. The Stream
  Deck app runs plugins on its own copy of Node.js, which it downloads when needed.
  If `~/Library/Logs/ElgatoStreamDeck/StreamDeck.log` says
  `NodeJS/manifest.json not found`, fully quit and reopen the Stream Deck app so
  it downloads Node.js, then restart the plugin.
- The LCD shows "CodexBar off", or every segment says "stale". `codexbar serve`
  is not answering. It may not be running, it may have crashed, or
  `codexbarBaseUrl` may point at the wrong port. "stale" means the LCD has had
  no good update for more than twice the poll interval. Check the server with
  `curl -s http://127.0.0.1:17777/health`. To keep it running, install the
  launchd agent from [CodexBar support](#codexbar-support). Its status is in
  `launchctl list | grep codexbar-serve` and its log in `/tmp/codexbar-serve.log`.
- The keys are blank or show "cmux offline". cmux is refusing the plugin's
  connection.
  `cmux capabilities | grep access_mode` should show `"automation"`. If it shows
  `cmuxOnly`, the setting has not taken effect. Set Socket Control Mode to
  Automation, then fully quit and relaunch cmux (reloading is not enough). The
  plugin log in `com.mrshu.muxboard.sdPlugin/logs/` shows `broken pipe` when
  cmux rejects it.
- There are no Muxboard keys, or the profile is missing. Connect the device and
  open Stream Deck once. For a packaged install, run the installer again and
  finish the profile step. From a checkout, close the app and run
  `npm run install-profile`. Then reopen Stream Deck and pick Muxboard in the
  profile dropdown.
- A key is stuck on an old state, such as "waiting" or an age that stops moving
  while the agent works. cmux has stopped sending agent hook events for that
  session, so Muxboard falls back to the last notification. To check,
  run `cmux events --limit 5` while the agent works. You will see recent UI
  events but no `agent.hook.*` events. The usual cause is a `PATH` problem that
  hides cmux's `claude` wrapper. See
  [hook troubleshooting](docs/cmux.md#troubleshooting-agent-hooks).

## Build from source

Use Node.js ≥ 22 for the development commands, and open Stream Deck once with
your device connected before installing the profile.

```bash
git clone https://github.com/mrshu/muxboard.git
cd muxboard
npm ci
npm run build
npx streamdeck link com.mrshu.muxboard.sdPlugin
```

Fully quit Stream Deck, then install the profile:

```bash
npm run install-profile
```

Reopen Stream Deck and select **Muxboard**. Start your agent sources and, for
the LCD, install the [CodexBar launchd agent](#codexbar-support).

### Headless preview and checks

These commands run without the device or the Stream Deck app:

```bash
npm test
npm run typecheck
npm run validate
npm run preview
```

`npm run preview` renders the same key and LCD images the device shows, using
fixed test data, and writes them to `out/dashboard.png` and
`out/dashboard-offline.png`.

The [development guide](docs/development.md) covers the watcher, the
architecture, the device profile format, and the Herdr and Stream Deck
integration tests.

## Privacy and scope

- Muxboard talks to CodexBar on `127.0.0.1`. Enabled Herdr machine profiles use
  their saved SSH routes, and the plugin never asks for SSH passwords.
- Muxboard does not read terminal contents. Agent state comes from structured
  data the sources provide. To find windows, it reads some process metadata
  and window titles.
- Muxboard only reads and focuses. It never dismisses cmux notifications, runs
  commands in agents, or answers approve/deny prompts.
- Nothing goes to the cloud, and nothing is stored beyond the plugin settings
  and an in-memory cache.
- Only the Stream Deck+ is supported.

## License

MIT
