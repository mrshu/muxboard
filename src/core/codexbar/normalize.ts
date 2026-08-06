import type { CreditBucket, ProviderUsage, UsageWindow } from "../types.js";

/** Raw CodexBar window object (primary/secondary/tertiary). */
interface RawWindow {
  usedPercent?: unknown;
  resetsAt?: unknown;
  resetDescription?: unknown;
  windowMinutes?: unknown;
}

/** Raw CodexBar `/usage?provider=X` element. */
export interface RawCodexbarUsage {
  provider?: unknown;
  source?: unknown;
  account?: unknown;
  updatedAt?: unknown;
  error?: { message?: unknown } | unknown;
  /** Codex nests windows at top level; claude/minimax nest them under `usage`. */
  primary?: RawWindow;
  secondary?: RawWindow;
  tertiary?: RawWindow;
  identity?: { accountEmail?: unknown } | unknown;
  /** Credit summary string (e.g. CommandCode "Go · $0.00 of $10.00"). */
  loginMethod?: unknown;
  usage?: {
    primary?: RawWindow;
    secondary?: RawWindow;
    tertiary?: RawWindow;
    identity?: { accountEmail?: unknown; loginMethod?: unknown } | unknown;
    loginMethod?: unknown;
    updatedAt?: unknown;
  };
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
    resetDescription: str(raw.resetDescription),
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
function windowSource(raw: RawCodexbarUsage): {
  primary?: RawWindow;
  secondary?: RawWindow;
  tertiary?: RawWindow;
  identity?: { accountEmail?: unknown; loginMethod?: unknown } | unknown;
  loginMethod?: unknown;
  updatedAt?: unknown;
} {
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
  return {
    primary: raw.primary,
    secondary: raw.secondary,
    tertiary: raw.tertiary,
    identity: raw.identity,
    loginMethod: raw.loginMethod,
    updatedAt: raw.updatedAt,
  };
}

function accountOf(identity: unknown, fallback: unknown): string | undefined {
  if (identity && typeof identity === "object") {
    const email = (identity as { accountEmail?: unknown }).accountEmail;
    if (str(email)) return email as string;
  }
  return str(fallback);
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
  const label = m[1]?.trim();
  return { label: label && label.length > 0 ? label : undefined, spent, total, unit: "usd" };
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

/** Read the credit string from the nested usage or its identity, whichever carries it. */
function loginMethodOf(src: {
  loginMethod?: unknown;
  identity?: { loginMethod?: unknown } | unknown;
}): unknown {
  if (src.loginMethod !== undefined) return src.loginMethod;
  const ident = src.identity;
  if (ident && typeof ident === "object") return (ident as { loginMethod?: unknown }).loginMethod;
  return undefined;
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
function creditModel(provider: string, src: {
  primary?: RawWindow;
  secondary?: RawWindow;
  tertiary?: RawWindow;
  loginMethod?: unknown;
  identity?: { loginMethod?: unknown } | unknown;
}): { session?: UsageWindow; credits: CreditBucket } | undefined {
  const id = provider.trim().toLowerCase();

  if (id === "commandcode") {
    const credits = parseCommandCodeUsdBucket(loginMethodOf(src));
    // Keep the plan/spend footer even when the monthly window is missing — a
    // gauge-less credit row still tells the operator their allowance.
    return credits ? { session: normalizeWindow(src.primary), credits } : undefined;
  }

  if (id !== "perplexity") return undefined;

  const candidate = (window: RawWindow | undefined) => {
    const credits = parsePerplexityBucket(window?.resetDescription);
    const session = normalizeWindow(window);
    return credits && session ? { session, credits } : undefined;
  };
  const primary = candidate(src.primary);
  const fallbacks = [candidate(src.tertiary), candidate(src.secondary)].filter(
    (value): value is { session: UsageWindow; credits: CreditBucket } => value !== undefined,
  );

  // Match CodexBar's own Perplexity waterfall (PerplexityUsageSnapshot.swift):
  // keep an available recurring grant visible, then fall back to purchased
  // credits before promotional credit. Upstream encodes a drained pool as
  // usedPercent 100, so remainingPercent is the availability signal.
  if (primary && primary.session.remainingPercent > 0) return primary;
  const available = fallbacks.find((value) => value.session.remainingPercent > 0);
  // With nothing available, prefer the recurring grant's real numbers over an
  // empty pool: "1000/1000 spent" is the state this gauge exists to show, and
  // upstream always emits a 0/0 secondary+tertiary that would otherwise win.
  return available ?? primary ?? fallbacks[0];
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
  const account = accountOf(src.identity, raw.account);
  const updatedAt = str(src.updatedAt) ?? str(raw.updatedAt);

  // Credit-metered providers (CommandCode, Perplexity) render as a single gauge
  // plus a credit footer, not the session/weekly rate-limit pair.
  const cm = creditModel(provider, src);
  if (cm) {
    return { provider, account, session: cm.session, weekly: undefined, credits: cm.credits, updatedAt, ok: true };
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
 * Parse the `/cost?provider=X` daily series, newest day first.
 *
 * The payload is `[{ daily: [{ date, totalCost, totalTokens }, ...] }]`. Returns
 * [] when unavailable.
 */
function dailyEntries(raw: unknown): DailyEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const daily = (raw[0] as { daily?: unknown })?.daily;
  if (!Array.isArray(daily)) return [];
  const entries: DailyEntry[] = [];
  for (const day of daily) {
    if (!day || typeof day !== "object") continue;
    entries.push({
      date: str((day as { date?: unknown }).date) ?? "",
      totalCost: num((day as { totalCost?: unknown }).totalCost),
      totalTokens: num((day as { totalTokens?: unknown }).totalTokens),
    });
  }
  return entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * Spend (USD) for a specific day. `today` is a local `YYYY-MM-DD`; when given,
 * returns that exact day's totalCost, or undefined when CodexBar has no entry
 * for it (its daily series can lag behind the real today). That keeps the LCD
 * footer from presenting a stale day's figure as "today's spend". Without
 * `today`, falls back to the most recent recorded day.
 */
export function extractCostToday(raw: unknown, today?: string): number | undefined {
  const days = dailyEntries(raw);
  if (today !== undefined) return days.find((d) => d.date === today)?.totalCost;
  return days[0]?.totalCost;
}

/** Token count for a day; same `today` semantics as extractCostToday. */
export function extractTokensToday(raw: unknown, today?: string): number | undefined {
  const days = dailyEntries(raw);
  if (today !== undefined) return days.find((d) => d.date === today)?.totalTokens;
  return days[0]?.totalTokens;
}
