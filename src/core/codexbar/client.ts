import type { ProviderUsage } from "../types.js";
import {
  extractCostToday,
  normalizeUsage,
  normalizeUsageResponse,
  type RawCodexbarUsage,
} from "./normalize.js";

/** Pluggable fetch-like fn so the client is testable without a server. */
export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
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

  constructor(opts: CodexbarClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:17777").replace(/\/+$/, "");
    this.fetchJson = opts.fetchJson ?? defaultFetchJson;
  }

  /** True when `/health` reports ok. */
  async health(): Promise<boolean> {
    try {
      const body = (await this.fetchJson(`${this.baseUrl}/health`)) as { status?: string };
      return body?.status === "ok";
    } catch {
      return false;
    }
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
      return { provider, ok: false, error: errMessage(err) };
    }

    if (usage.ok) {
      try {
        const cost = await this.fetchJson(
          `${this.baseUrl}/cost?provider=${encodeURIComponent(provider)}`,
        );
        usage = { ...usage, costTodayEur: extractCostToday(cost) };
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
   * is fetched per provider and attached. Returns [] if the request fails.
   */
  async getAllUsage(): Promise<ProviderUsage[]> {
    let raw: unknown;
    try {
      raw = await this.fetchJson(`${this.baseUrl}/usage`);
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];

    const usages = raw
      .filter((r): r is RawCodexbarUsage => !!r && typeof r === "object")
      .map((r) => normalizeUsage(r));

    // Attach today's cost per provider (best-effort, concurrent).
    await Promise.all(
      usages.map(async (u, i) => {
        if (!u.ok) return;
        try {
          const cost = await this.fetchJson(
            `${this.baseUrl}/cost?provider=${encodeURIComponent(u.provider)}`,
          );
          usages[i] = { ...u, costTodayEur: extractCostToday(cost) };
        } catch {
          // Cost is optional.
        }
      }),
    );
    return usages;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
