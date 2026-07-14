import type { ProviderUsage, UsageWindow } from "../types.js";

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
  identity?: { accountEmail?: unknown } | unknown;
  usage?: {
    primary?: RawWindow;
    secondary?: RawWindow;
    identity?: { accountEmail?: unknown } | unknown;
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
  identity?: { accountEmail?: unknown } | unknown;
  updatedAt?: unknown;
} {
  const nested = raw.usage;
  if (
    nested &&
    typeof nested === "object" &&
    (nested.primary?.usedPercent !== undefined || nested.secondary?.usedPercent !== undefined)
  ) {
    return nested;
  }
  return {
    primary: raw.primary,
    secondary: raw.secondary,
    identity: raw.identity,
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

/** Normalize one raw CodexBar usage object for a provider. */
export function normalizeUsage(raw: RawCodexbarUsage, providerHint?: string): ProviderUsage {
  const provider = str(raw.provider) ?? providerHint ?? "unknown";

  // Error payloads (e.g. expired token) surface as an unavailable provider.
  if (raw.error && typeof raw.error === "object") {
    const message = str((raw.error as { message?: unknown }).message) ?? "provider error";
    return { provider, ok: false, error: message };
  }

  const src = windowSource(raw);
  return {
    provider,
    account: accountOf(src.identity, raw.account),
    session: normalizeWindow(src.primary),
    weekly: normalizeWindow(src.secondary),
    updatedAt: str(src.updatedAt) ?? str(raw.updatedAt),
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

/** Today's total spend (USD) — the most recent day's totalCost. */
export function extractCostToday(raw: unknown): number | undefined {
  return dailyEntries(raw)[0]?.totalCost;
}

/** Today's token count — the most recent day's totalTokens. */
export function extractTokensToday(raw: unknown): number | undefined {
  return dailyEntries(raw)[0]?.totalTokens;
}
