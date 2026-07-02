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
  /**
   * Optional CodexBar provider allow-list / order. Empty (default) shows every
   * provider CodexBar has enabled, auto-discovered — not hardcoded.
   */
  codexbarProviders: string[];
  /** cmux poll interval (ms). */
  cmuxPollMs: number;
  /** CodexBar poll interval (ms). */
  codexbarPollMs: number;
  /**
   * Map a notification name substring → agent, for custom-named agents cmux
   * doesn't tag (e.g. a codex CLI shown as "fieldtheory-cli"). Case-insensitive.
   */
  agentAliases: Record<string, AgentKind>;
  /**
   * Workspace CPU-percent (summed across cores, from `cmux top`) at or above
   * which a pane counts as "working" because a command is running — even if the
   * agent itself has gone idle. Tuned to sit above agent-idle overhead (~15%)
   * and below a real CPU-bound command (≥100% = a full core).
   */
  busyCpuPercent: number;
  /** orca CLI binary path or name. */
  orcaBin: string;
  /** Orca poll interval (ms). */
  orcaPollMs: number;
  /**
   * Whether to run the Orca poller. "auto" (default) starts it only when an
   * Orca runtime is reachable; true forces it on; false disables it.
   */
  enableOrca: "auto" | boolean;
}

export const DEFAULT_CONFIG: MuxboardConfig = {
  cmuxBin: "cmux",
  // 17777 keeps CodexBar's default 8080 free; run `codexbar serve --port 17777`.
  codexbarBaseUrl: "http://127.0.0.1:17777",
  codexbarProviders: [],
  cmuxPollMs: 1500,
  codexbarPollMs: 45000,
  // Agents are detected from the running process; this is only a manual override
  // fallback (name substring → agent) for cases that can't be detected.
  agentAliases: {},
  busyCpuPercent: 40,
  orcaBin: "orca",
  orcaPollMs: 1500,
  enableOrca: "auto",
};

const ALL_AGENTS: AgentKind[] = ["claude", "codex", "omp", "pi", "unknown"];

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
    agentAliases: cleanAliases(p.agentAliases) ?? DEFAULT_CONFIG.agentAliases,
    busyCpuPercent: clampInt(p.busyCpuPercent, 1, 100_000, DEFAULT_CONFIG.busyCpuPercent),
    orcaBin: nonEmpty(p.orcaBin) ?? DEFAULT_CONFIG.orcaBin,
    orcaPollMs: clampInt(p.orcaPollMs, 500, 10_000, DEFAULT_CONFIG.orcaPollMs),
    enableOrca: coerceEnableOrca(p.enableOrca),
  };
}

function cleanAliases(v: unknown): Record<string, AgentKind> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, AgentKind> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.trim() && ALL_AGENTS.includes(val as AgentKind)) out[k.trim()] = val as AgentKind;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

function coerceEnableOrca(v: unknown): "auto" | boolean {
  if (v === true || v === false) return v;
  return "auto";
}
