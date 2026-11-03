# CodexBar integration

[Back to the README](../README.md)

## Provider discovery and quota windows

Muxboard polls `codexbar serve` (default `http://127.0.0.1:17777`). It discovers
enabled providers through aggregate `/usage`, recovers previously known
providers omitted by that response through `/usage?provider=<id>`, and fetches
costs per provider. An explicit `codexbarProviders` list restricts and orders
the result, and supplies known ids for recovery requests. It handles both
payload shapes CodexBar emits:

- Codex exposes `primary`/`secondary` windows at the top level.
- Claude and others nest them under `usage`.

The provider list is discovered from CodexBar, rather than limited to the
examples in the dashboard image. Enabled Codex, Claude, MiniMax, Kimi, Gemini,
CommandCode, Perplexity, and other providers exposed by the server share the
same LCD. `codexbarProviders` can restrict or reorder them.

Each window provides `usedPercent`, `resetsAt`, `windowMinutes`, and a
`resetDescription`. For ordinary rate-limit providers, `primary` is usually the
session (5h) and `secondary` the weekly (7d) window. When the session window is
absent but CodexBar reports a model-scoped limit in `extraRateWindows` (Claude's
"Fable only" weekly), the segment shows `W` first and the scoped limit second,
labeled by its title's initial (`F`).

## Credit pools and monthly grants

Credit allowances can accompany rolling quotas or replace them. Muxboard
keeps CommandCode's session/weekly gauges when both windows are reported and
shows its grant in the footer. Credit-only accounts and Perplexity use a single
credit gauge plus a spend/allowance footer. CommandCode carries
its plan + dollars in a `loginMethod` string (`"Go · $0.00 of $10.00"`,
optionally followed by a purchased-credit balance). Which window holds its
monthly grant depends on the CodexBar build: up to v0.47.0 the grant is the only
window and arrives as `primary`, while
[CodexBar#2630](https://github.com/steipete/CodexBar/pull/2630) added rolling
rate limits, moving the grant to `tertiary` behind a 5h `primary` and a weekly
`secondary`. Muxboard follows the grant to whichever window carries it, and on
the newer shape keeps the ordinary session/weekly gauges with the grant in the
footer. Perplexity reports
recurring, purchased, and promotional pools across its windows (`primary` is
null when the recurring grant is exhausted or absent). Muxboard gauges
Perplexity's recurring pool while it has credit left, then falls back to
purchased and finally promotional credit, parsing the optional
promotion-expiry suffix. When every pool is drained it keeps the recurring
grant's own numbers rather than an empty `0/0` bucket.

These two are matched by provider id, not by the shape of their display string,
because ordinary rate-limit providers emit count strings too — Alibaba's coding
plan describes each of its windows `"<used> / <total> used"`, and Kilo emits
`"<used>/<total> credits"`, which is indistinguishable from Perplexity's. Shape
dispatch would silently replace those providers' session/weekly gauges.

## CommandCode authentication

CommandCode can need an interactive cookie refresh when browser-cookie import
requires Keychain access. CodexBar checks its saved session first, then tries
browser import if that session is missing or invalid. Background imports can
read cookies when Keychain access is already granted, but cannot prompt for
access. The CodexBar app or an interactive CLI refresh can request that access,
so the menu bar can show live numbers while `codexbar serve` reports a missing
or expired session. Retry interactively with
`codexbar cookie refresh --provider commandcode --allow-keychain-prompt`.
Without `--allow-keychain-prompt`, the explicit cookie-refresh command can
return `status: "blocked"` rather than attempt decryption. CodexBar v0.46.0
also had a separate session-persistence bug
([steipete/CodexBar#2541](https://github.com/steipete/CodexBar/issues/2541)),
fixed upstream by
[steipete/CodexBar#2564](https://github.com/steipete/CodexBar/pull/2564).
Upgrade affected builds before retrying. Muxboard renders provider errors as
unavailable, and the tile populates on its own once CodexBar returns usage. It
is a pure consumer of `codexbar serve` and has no cookie configuration of its own.

## Perplexity authentication and rate limits

Perplexity has two observed failure modes, told apart by the message.
`codexbar serve` can answer
`{"code":1,"message":"No available fetch strategy for perplexity"}` when no
session cookie is currently resolvable. A refresh in the CodexBar UI may recover
it if a valid browser session is available. Separately, `serve` can return a
provider error payload containing `Perplexity API error: HTTP 429`, indicating
rate limiting even with a valid cookie. Cookie refresh does not resolve rate
limiting. Allow the limit to subside before retrying. Muxboard renders either
provider error as unavailable and restores the gauge on a successful poll. It
does not request authentication or cookie refreshes from CodexBar.

## Pace, costs, and staleness

The pace marker/number is derived locally from `resetsAt` + `windowMinutes`
(elapsed-vs-used). Windows with no time bounds (e.g. an "Unlimited" weekly) show
no pace. Today's spend and token count come from `/cost?provider=<p>` (a daily
series). Amounts are treated as USD since CodexBar emits no currency code. A
provider that returns an `{ error }` object (e.g. an expired token) is shown as
unavailable. The strip is flagged `STALE` when its last non-offline poll is older
than 2× the poll interval. This is a global poll clock, not an age check on each
provider's payload, and does not alone prove that the server has stopped.
