import type { AgentKind } from "./core/types.js";

/**
 * Muxboard configuration, persisted via the plugin's global settings.
 *
 * All fields have safe defaults so the plugin runs out of the box against a
 * standard cmux + `codexbar serve` setup.
 */
export interface MuxboardConfig {
  /**
   * cmux binary path or name. The plugin spawns cmux directly, which requires
   * cmux's automation mode (Settings → Automation → Socket Control Mode →
   * Automation) so the plugin's out-of-session process is accepted.
   */
  cmuxBin: string;
  /** Base URL of `codexbar serve`. */
  codexbarBaseUrl: string;
  /** CodexBar providers to poll/cycle, in display order. */
  codexbarProviders: string[];
  /** cmux poll interval (ms). */
  cmuxPollMs: number;
  /** CodexBar poll interval (ms). */
  codexbarPollMs: number;
  /** Agents allowed onto the attention queue. */
  enabledAgents: AgentKind[];
}

export const DEFAULT_CONFIG: MuxboardConfig = {
  cmuxBin: "cmux",
  // 17777 keeps CodexBar's default 8080 free; run `codexbar serve --port 17777`.
  codexbarBaseUrl: "http://127.0.0.1:17777",
  codexbarProviders: ["codex", "claude"],
  cmuxPollMs: 1500,
  codexbarPollMs: 45000,
  enabledAgents: ["claude", "codex", "pi", "unknown"],
};

const ALL_AGENTS: AgentKind[] = ["claude", "codex", "pi", "unknown"];

/**
 * Merge partial (possibly user-supplied) settings over the defaults, coercing
 * and clamping each field so malformed settings can never crash the plugin.
 */
export function resolveConfig(partial: Partial<MuxboardConfig> | undefined | null): MuxboardConfig {
  const p = partial ?? {};
  return {
    cmuxBin: nonEmpty(p.cmuxBin) ?? DEFAULT_CONFIG.cmuxBin,
    codexbarBaseUrl: normalizeUrl(p.codexbarBaseUrl) ?? DEFAULT_CONFIG.codexbarBaseUrl,
    codexbarProviders: cleanStrings(p.codexbarProviders) ?? DEFAULT_CONFIG.codexbarProviders,
    cmuxPollMs: clampInt(p.cmuxPollMs, 500, 10_000, DEFAULT_CONFIG.cmuxPollMs),
    codexbarPollMs: clampInt(p.codexbarPollMs, 5_000, 600_000, DEFAULT_CONFIG.codexbarPollMs),
    enabledAgents: cleanAgents(p.enabledAgents) ?? DEFAULT_CONFIG.enabledAgents,
  };
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function normalizeUrl(v: unknown): string | undefined {
  const s = nonEmpty(v);
  if (!s) return undefined;
  return s.replace(/\/+$/, "");
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function cleanStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  return out.length > 0 ? out : undefined;
}

function cleanAgents(v: unknown): AgentKind[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is AgentKind => ALL_AGENTS.includes(x as AgentKind));
  return out.length > 0 ? out : undefined;
}
