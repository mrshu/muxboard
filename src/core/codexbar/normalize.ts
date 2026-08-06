import type { CreditBucket, ProviderUsage, UsageWindow } from "../types.js";

/** Raw CodexBar window object (primary/secondary/tertiary). */
interface RawWindow {
  usedPercent?: unknown;
  resetsAt?: unknown;
  resetDescription?: unknown;
  windowMinutes?: unknown;
}

/**
 * The object carrying a provider's windows: either the raw element itself
 * (Codex) or its nested `usage` (claude/minimax). See `windowSource`.
 */
interface WindowSource {
  primary?: RawWindow;
  secondary?: RawWindow;
  tertiary?: RawWindow;
  /** Some providers carry the account/credit fields one level down. */
  identity?: { accountEmail?: unknown; loginMethod?: unknown };
  /** Credit summary string (e.g. CommandCode "Go · $0.00 of $10.00"). */
  loginMethod?: unknown;
  updatedAt?: unknown;
}

/** Raw CodexBar `/usage?provider=X` element. */
export interface RawCodexbarUsage extends WindowSource {
  provider?: unknown;
  account?: unknown;
  error?: { message?: unknown } | unknown;
  /** Codex nests windows at top level; claude/minimax nest them under `usage`. */
  usage?: WindowSource;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const clamp = (n: number): number => Math.max(0, Math.min(100, n));

function normalizeWindow(raw: RawWindow | undefined): UsageWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const used = num(raw.usedPercent);
  if (used === undefined) return undefined;
  return {
    usedPercent: clamp(used),
    remainingPercent: clamp(100 - used),
    resetsAt: str(raw.resetsAt),
    windowMinutes: num(raw.windowMinutes),
  };
}

/**
 * Pick the object that actually holds the primary/secondary windows.
 *
 * Codex puts them at the top level; Claude/MiniMax nest them under `usage`.
 * We prefer whichever location actually carries a window. Keying off
 * `primary.usedPercent` alone is not enough: some providers (e.g. Codex on
 * newer CodexBar builds) nest under `usage` with a null `primary` but a live
 * `secondary` (weekly) window — checking only `primary` there wrongly falls
 * back to the empty top level and drops the weekly gauge entirely.
 */
function windowSource(raw: RawCodexbarUsage): WindowSource {
  const nested = raw.usage;
  if (
    nested &&
    typeof nested === "object" &&
    (nested.primary?.usedPercent !== undefined ||
      nested.secondary?.usedPercent !== undefined ||
      nested.tertiary?.usedPercent !== undefined)
  ) {
    return nested;
  }
  // The raw element IS a WindowSource — its own windows live at the top level.
  return raw;
}

/**
 * Parse CommandCode's monthly-grant summary from its `loginMethod` string.
 *
 * CodexBar joins three optional parts with " · " (CommandCodeUsageSnapshot
 * .makeLoginMethod): a plan name, the grant summary, then a purchased-credit
 * balance — "<plan> · $<spent> of $<budget> · + $<purchased> credits".
 *
 * The leading plan segment is optional in the builder, so we don't require it.
 * Today it is always present alongside an "$x of $y" grant (the grant total is
 * `plan?.monthlyCreditsUSD`, so a total implies a plan, and catalog plans have
 * non-empty display names) — accepting the bare form is drift insurance, not a
 * reachable fix.
 *
 * NOT parsed: the plan-less "$<remaining> remaining" form CodexBar emits when
 * no allowance total is published (free tier, or subscription enrichment
 * unavailable), and a purchased-only "+ $<n> credits". Both are balances with no
 * denominator, which this credit model has no footer semantic for.
 */
function parseCommandCodeUsdBucket(loginMethod: unknown): CreditBucket | undefined {
  const s = str(loginMethod);
  if (!s) return undefined;
  const m = /^(?:(.*?)\s*·\s*)?\$([\d,]+(?:\.\d+)?)\s+of\s+\$([\d,]+(?:\.\d+)?)(?:\s*·\s*\+\s*\$[\d,]+(?:\.\d+)?\s+credits)?\s*$/.exec(s);
  if (!m) return undefined;
  const spent = Number(m[2].replace(/,/g, ""));
  const total = Number(m[3].replace(/,/g, ""));
  if (!Number.isFinite(spent) || !Number.isFinite(total)) return undefined;
  return { label: str(m[1]?.trim()), spent, total, unit: "usd" };
}

/**
 * Parse Perplexity's known credit-pool descriptions. The optional expiry suffix
 * appears on promotional balances (for example, "50/100 bonus · exp. Aug 31").
 */
function parsePerplexityBucket(resetDescription: unknown): CreditBucket | undefined {
  const s = str(resetDescription);
  if (!s) return undefined;
  const m = /^(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s+(credits|bonus)(?:\s*·\s*exp\.\s+.+)?\s*$/.exec(s);
  if (!m) return undefined;
  const spent = Number(m[1].replace(/,/g, ""));
  const total = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(spent) || !Number.isFinite(total)) return undefined;
  return { spent, total, unit: m[3].toLowerCase() };
}

/**
 * Credit-metered providers use provider-specific CodexBar contracts, keyed by
 * provider id rather than by data shape: ordinary rate-limit providers emit the
 * same count-shaped descriptions, so shape-only dispatch would silently replace
 * their S/W gauges. Alibaba's coding plan describes all three of its rate-limit
 * windows "<used> / <total> used" (AlibabaCodingPlanUsageSnapshot.swift), and
 * Kilo emits "<used>/<total> credits" (KiloUsageFetcher.swift) — the latter is
 * indistinguishable from Perplexity's own string, so no regex can separate them.
 */
function creditModel(
  provider: string,
  src: WindowSource,
): { session?: UsageWindow; weekly?: UsageWindow; credits: CreditBucket } | undefined {
  const id = provider.trim().toLowerCase();

  if (id === "commandcode") {
    // Presence, not nullishness: an explicitly null top-level `loginMethod`
    // (Swift encodes a nil optional as JSON null) means "this build reports no
    // credit string here" and must NOT fall through to identity's copy.
    const credits = parseCommandCodeUsdBucket(
      src.loginMethod !== undefined ? src.loginMethod : src.identity?.loginMethod,
    );
    // Keep the plan/spend footer even when the monthly window is missing — a
    // gauge-less credit row still tells the operator their allowance.
    if (!credits) return undefined;
    // Which window carries the grant moved upstream. CodexBar <= v0.47.0 emits
    // the monthly grant alone as `primary`; since "parse Command Code usage
    // windows" (CodexBar#2630, landed after the v0.47.0 cut) `toUsageSnapshot`
    // returns primary = rolling 5h, secondary = rolling weekly, tertiary = the
    // grant. Both rolling windows are optional (`RateWindow?`), so treat a
    // present `secondary` as the signal that this is the newer three-window
    // shape: those are ordinary rate-limit windows and keep the S/W pair, while
    // the grant is carried by the credit footer. Otherwise the grant is the only
    // window there is, and it is the gauge — from `tertiary` when the newer
    // build reported no rolling limits, else from `primary`.
    const weekly = normalizeWindow(src.secondary);
    if (weekly) return { session: normalizeWindow(src.primary), weekly, credits };
    return { session: normalizeWindow(src.tertiary) ?? normalizeWindow(src.primary), credits };
  }

  if (id !== "perplexity") return undefined;

  // CodexBar's own Perplexity waterfall (PerplexityUsageSnapshot.swift): the
  // recurring grant, then purchased credit, then promotional credit.
  const pools = [src.primary, src.tertiary, src.secondary]
    .map((window) => {
      const credits = parsePerplexityBucket(window?.resetDescription);
      const session = normalizeWindow(window);
      return credits && session ? { session, credits } : undefined;
    })
    .filter((pool) => pool !== undefined);

  // Keep the first pool with credit left visible; upstream encodes a drained
  // pool as usedPercent 100, so remainingPercent is the availability signal.
  // With nothing available, prefer the earliest pool's real numbers over an
  // empty one: "1000/1000 spent" is the state this gauge exists to show, and
  // upstream always emits a 0/0 secondary+tertiary that would otherwise win.
  return pools.find((pool) => pool.session.remainingPercent > 0) ?? pools[0];
}

/** Normalize one raw CodexBar usage object for a provider. */
export function normalizeUsage(raw: RawCodexbarUsage, providerHint?: string): ProviderUsage {
  const provider = str(raw.provider) ?? providerHint ?? "unknown";

  // Error payloads (e.g. expired token) surface as an unavailable provider.
  if (raw.error && typeof raw.error === "object") {
    const message = str((raw.error as { message?: unknown }).message) ?? "provider error";
    return { provider, ok: false, error: message };
  }

  const src = windowSource(raw);
  const account = str(src.identity?.accountEmail) ?? str(raw.account);
  const updatedAt = str(src.updatedAt) ?? str(raw.updatedAt);

  // Credit-metered providers (CommandCode, Perplexity) render as a single gauge
  // plus a credit footer, not the session/weekly rate-limit pair.
  const cm = creditModel(provider, src);
  if (cm) {
    return { provider, account, session: cm.session, weekly: cm.weekly, credits: cm.credits, updatedAt, ok: true };
  }
  return {
    provider,
    account,
    session: normalizeWindow(src.primary),
    weekly: normalizeWindow(src.secondary),
    updatedAt,
    ok: true,
  };
}

/**
 * Normalize a `/usage?provider=X` response (an array) into a single
 * ProviderUsage. CodexBar returns one element per provider query.
 */
export function normalizeUsageResponse(raw: unknown, providerHint?: string): ProviderUsage {
  if (Array.isArray(raw) && raw.length > 0 && raw[0] && typeof raw[0] === "object") {
    return normalizeUsage(raw[0] as RawCodexbarUsage, providerHint);
  }
  return {
    provider: providerHint ?? "unknown",
    ok: false,
    error: "empty response",
  };
}

/** One day of the `/cost` series. */
interface DailyEntry {
  date: string;
  totalCost?: number;
  totalTokens?: number;
}

/**
 * Pick one day out of the `/cost?provider=X` series, whose payload is
 * `[{ daily: [{ date, totalCost, totalTokens }, ...] }]`.
 *
 * `today` is a local `YYYY-MM-DD`; when given, only that exact day matches, so
 * a CodexBar series lagging behind the real today yields undefined rather than
 * presenting a stale day's figures as "today's". Without it, the most recent
 * recorded day wins. Returns undefined when the payload is unusable.
 */
function dayEntry(raw: unknown, today?: string): DailyEntry | undefined {
  const daily = Array.isArray(raw) ? (raw[0] as { daily?: unknown } | undefined)?.daily : undefined;
  if (!Array.isArray(daily)) return undefined;
  let best: DailyEntry | undefined;
  for (const day of daily) {
    if (!day || typeof day !== "object") continue;
    const date = str((day as { date?: unknown }).date) ?? "";
    if (today !== undefined ? date !== today : best !== undefined && date <= best.date) continue;
    best = {
      date,
      totalCost: num((day as { totalCost?: unknown }).totalCost),
      totalTokens: num((day as { totalTokens?: unknown }).totalTokens),
    };
    if (today !== undefined) break; // first exact match wins, as the sort did
  }
  return best;
}

/** Spend (USD) for a day; see `dayEntry` for the `today` semantics. */
export const extractCostToday = (raw: unknown, today?: string): number | undefined =>
  dayEntry(raw, today)?.totalCost;

/** Token count for a day; see `dayEntry` for the `today` semantics. */
export const extractTokensToday = (raw: unknown, today?: string): number | undefined =>
  dayEntry(raw, today)?.totalTokens;
