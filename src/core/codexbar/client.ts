import type { ProviderUsage } from "../types.js";
import {
  extractCostToday,
  extractTokensToday,
  normalizeUsage,
  normalizeUsageResponse,
  type RawCodexbarUsage,
} from "./normalize.js";

/** Merge the /cost-derived spend + token fields (for `today`) onto a usage. */
function withCost(usage: ProviderUsage, cost: unknown, today: string): ProviderUsage {
  return {
    ...usage,
    costTodayUsd: extractCostToday(cost, today),
    tokensToday: extractTokensToday(cost, today),
  };
}

/** Pluggable fetch-like fn so the client is testable without a server. */
export type FetchJson = (url: string) => Promise<unknown>;

/**
 * CodexBar's endpoints can be very slow on some builds (the aggregate `/usage`
 * and even individual providers have been observed at 10-20s+), so the timeout
 * must be generous or discovery/usage silently aborts and the LCD collapses to
 * whatever last responded in time. Overridable via CodexbarClientOptions.
 */
const DEFAULT_TIMEOUT_MS = 30000;

const makeFetchJson =
  (timeoutMs: number): FetchJson =>
  async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

export interface CodexbarClientOptions {
  /** Base URL of `codexbar serve`. Defaults to http://127.0.0.1:17777. */
  baseUrl?: string;
  /** Injected JSON fetcher for tests. */
  fetchJson?: FetchJson;
  /** Per-request timeout in ms. CodexBar can be slow; defaults to 30000. */
  timeoutMs?: number;
  /** Epoch-ms clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Client for `codexbar serve`.
 *
 * Note: `/usage?provider=all` returns empty on the verified build, so callers
 * must request providers individually.
 */
export class CodexbarClient {
  private readonly baseUrl: string;
  private readonly fetchJson: FetchJson;
  private readonly now: () => number;

  constructor(opts: CodexbarClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:17777").replace(/\/+$/, "");
    this.fetchJson = opts.fetchJson ?? makeFetchJson(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Local calendar date (YYYY-MM-DD), matching CodexBar's local daily buckets. */
  private today(): string {
    const d = new Date(this.now());
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  /**
   * Fetch usage for a single provider, including today's cost when available.
   * Never throws: failures resolve to an `ok: false` ProviderUsage.
   */
  async getUsage(provider: string): Promise<ProviderUsage> {
    let usage: ProviderUsage;
    try {
      const raw = await this.fetchJson(
        `${this.baseUrl}/usage?provider=${encodeURIComponent(provider)}`,
      );
      usage = normalizeUsageResponse(raw, provider);
    } catch (err) {
      return { provider, ok: false, error: errMessage(err), transient: true };
    }

    if (usage.ok) {
      try {
        const cost = await this.fetchJson(
          `${this.baseUrl}/cost?provider=${encodeURIComponent(provider)}`,
        );
        usage = withCost(usage, cost, this.today());
      } catch {
        // Cost is optional; ignore failures.
      }
    }
    return usage;
  }

  /** Fetch usage for several providers concurrently. */
  async getUsageAll(providers: string[]): Promise<ProviderUsage[]> {
    return Promise.all(providers.map((p) => this.getUsage(p)));
  }

  /**
   * Discover and fetch usage for ALL of CodexBar's enabled providers.
   *
   * `GET /usage` (no provider param) returns one entry per enabled provider, in
   * CodexBar's own order — so the provider list is never hardcoded. Today's cost
   * is fetched per provider and attached.
   *
   * That aggregate endpoint is unreliable on some CodexBar builds: it can return
   * empty, or silently omit a provider whose shape changed (e.g. Codex after it
   * dropped its 5h session window). The per-provider endpoint stays stable, so
   * any `knownProviders` the aggregate did not cover are fetched individually and
   * merged in. This keeps the LCD from blanking a provider — or the whole strip —
   * on a flaky discovery call. Pass previously-seen provider ids for `knownProviders`.
   */
  async getAllUsage(knownProviders: string[] = []): Promise<ProviderUsage[]> {
    let raw: unknown;
    const today = this.today();
    try {
      raw = await this.fetchJson(`${this.baseUrl}/usage`);
    } catch {
      raw = undefined;
    }

    const usages = Array.isArray(raw)
      ? raw
          .filter((r): r is RawCodexbarUsage => !!r && typeof r === "object")
          .map((r) => normalizeUsage(r))
      : [];

    // Attach today's cost per provider (best-effort, concurrent).
    await Promise.all(
      usages.map(async (u, i) => {
        if (!u.ok) return;
        try {
          const cost = await this.fetchJson(
            `${this.baseUrl}/cost?provider=${encodeURIComponent(u.provider)}`,
          );
          usages[i] = withCost(u, cost, today);
        } catch {
          // Cost is optional.
        }
      }),
    );

    // Fill any known provider the aggregate omitted via the stable per-provider
    // endpoint (getUsage already merges cost). Preserves aggregate order, then
    // appends the recovered ones.
    const covered = new Set(usages.map((u) => u.provider));
    const missing = knownProviders.filter((p) => !covered.has(p));
    if (missing.length > 0) {
      usages.push(...(await this.getUsageAll(missing)));
    }
    return usages;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
