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
 * Parse CodexBar's `loginMethod` dollar string (e.g. "Go · $0.00 of $10.00",
 * CommandCode) into a plan label + USD spend/allowance. Returns undefined when
 * the string isn't a dollar summary, so other providers (whose loginMethod means
 * something else, e.g. "Claude Max") are left untouched.
 */
function parseUsdBucket(loginMethod: unknown): CreditBucket | undefined {
  const s = str(loginMethod);
  if (!s) return undefined;
  // "<plan> · $<spent> of $<budget>" — · is U+00B7; tolerate surrounding space.
  const m = /^(.*?)\s*·\s*\$([\d,]+(?:\.\d+)?)\s+of\s+\$([\d,]+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return undefined;
  const spent = Number(m[2].replace(/,/g, ""));
  const total = Number(m[3].replace(/,/g, ""));
  if (!Number.isFinite(spent) || !Number.isFinite(total)) return undefined;
  const label = m[1].trim();
  return { label: label.length > 0 ? label : undefined, spent, total, unit: "usd" };
}

/**
 * Parse a window's "<spent>/<total> <unit>" description (e.g. Perplexity's
 * "0/12000 credits" or "0/0 bonus") into a count bucket. Returns undefined for
 * ordinary reset descriptions like "Aug 6 at 07:14".
 */
function parseCountBucket(resetDescription: unknown): CreditBucket | undefined {
  const s = str(resetDescription);
  if (!s) return undefined;
  // "<spent>/<total> <unit>", leading-digit anchored. Real reset descriptions are
  // month-name dates ("Aug 6 at 07:14") that start with a letter and never match;
  // only credit descriptions take this shape. (A numeric-locale date like "6/20 PM"
  // would false-match, but CodexBar doesn't emit those.)
  const m = /^(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s+([A-Za-z]+)$/.exec(s);
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
 * Credit-metered providers don't fit the session/weekly rate-limit model — they
 * spend against an allowance, shown as one gauge + a footer. Returns the gauge
 * window + bucket, or undefined for ordinary rate-limit providers.
 *
 * Dispatch is by data SHAPE, not provider id: any provider whose `loginMethod`
 * is "<plan> · $x of $y", or that has a window described "<spent>/<total> <unit>",
 * is treated as credit-metered. Real rate-limit payloads don't match either form
 * (reset descriptions start with a letter, e.g. "Aug 6 at 07:14").
 *
 * CommandCode: dollars from `loginMethod`, gauge = the monthly `primary` window.
 * Perplexity: pick the window with the largest allowance as the gauge — the real
 * "0/12000 credits" beats an empty "0/0 bonus", and an account carrying only a
 * "0/0 bonus" still renders credit-framed rather than as a misleading weekly cap.
 */
function creditModel(src: {
  primary?: RawWindow;
  secondary?: RawWindow;
  tertiary?: RawWindow;
  loginMethod?: unknown;
  identity?: { loginMethod?: unknown } | unknown;
}): { session?: UsageWindow; credits: CreditBucket } | undefined {
  const usd = parseUsdBucket(loginMethodOf(src));
  if (usd) return { session: normalizeWindow(src.primary), credits: usd };

  const candidates = [src.primary, src.secondary, src.tertiary]
    .map((w) => ({ w, b: parseCountBucket(w?.resetDescription) }))
    .filter((c): c is { w: RawWindow; b: CreditBucket } => !!c.b);
  if (candidates.length > 0) {
    // Largest allowance wins (stable sort → earliest window on a tie), so a real
    // purchased bucket beats an empty bonus; a zero-only account still qualifies.
    candidates.sort((a, b) => b.b.total - a.b.total);
    const top = candidates[0];
    return { session: normalizeWindow(top.w), credits: top.b };
  }
  return undefined;
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
  const cm = creditModel(src);
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
