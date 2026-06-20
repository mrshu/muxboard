import type { AgentKind, AttentionReason } from "../types.js";

/** Per-agent visual identity (palette + glyph). No trademarked logos. */
export interface AgentTheme {
  /** Background gradient stops, top → bottom. */
  bg: [string, string];
  /** Accent used for the glyph chip + agent rule. */
  accent: string;
  /** Foreground text color. */
  fg: string;
  /** Short non-branded glyph. */
  glyph: string;
  /** Short label. */
  label: string;
}

const AGENT_THEMES: Record<AgentKind, AgentTheme> = {
  // Claude: warm orange.
  claude: { bg: ["#3a2415", "#241208"], accent: "#d97746", fg: "#f7e9df", glyph: "C", label: "CLAUDE" },
  // Codex: green/blue teal.
  codex: { bg: ["#0f2a2b", "#06181b"], accent: "#3fb6a8", fg: "#e0f5f3", glyph: "X", label: "CODEX" },
  // Pi: purple.
  pi: { bg: ["#241433", "#140a1f"], accent: "#a779e0", fg: "#efe6f7", glyph: "π", label: "PI" },
  // Unknown: neutral grey.
  unknown: { bg: ["#222428", "#141518"], accent: "#7d828c", fg: "#e6e8ec", glyph: "?", label: "AGENT" },
};

export function agentTheme(agent: AgentKind): AgentTheme {
  return AGENT_THEMES[agent] ?? AGENT_THEMES.unknown;
}

/** Per-reason treatment: stronger = more urgent. */
export interface ReasonTheme {
  /** Band/label color. */
  color: string;
  /** Short uppercase label. */
  label: string;
  /** 0..3 urgency, used to scale the visual treatment. */
  urgency: number;
}

const REASON_THEMES: Record<AttentionReason, ReasonTheme> = {
  failed: { color: "#ff4d4f", label: "FAILED", urgency: 3 },
  blocked: { color: "#ffb02e", label: "BLOCKED", urgency: 2 },
  waiting: { color: "#ffd23f", label: "WAITING", urgency: 2 },
  finished: { color: "#4ec9b0", label: "DONE", urgency: 1 },
  unknown: { color: "#9aa0aa", label: "ATTN", urgency: 0 },
};

export function reasonTheme(reason: AttentionReason): ReasonTheme {
  return REASON_THEMES[reason] ?? REASON_THEMES.unknown;
}

/**
 * CodexBar's own per-provider brand colors, taken from the CodexBar source
 * (ProviderDescriptor color definitions) so the LCD matches the menubar app.
 */
const PROVIDER_COLORS: Record<string, string> = {
  codex: "#49A3B0",
  openai: "#0F8270",
  claude: "#CC7C5E",
  minimax: "#FE603C",
  gemini: "#AB87EA",
  kimi: "#FE603C",
  "kimi-k2": "#4C00FF",
  grok: "#10A37F",
  copilot: "#A855F7",
  cursor: "#00BFA5",
  deepseek: "#527DF0",
  mistral: "#FF500F",
  factory: "#FF6B35",
};

/** Brand color for a CodexBar provider; neutral grey for unknown providers. */
export function providerColor(provider: string): string {
  return PROVIDER_COLORS[provider.toLowerCase()] ?? "#9aa0aa";
}

/** Status color ramp for CodexBar usage bars (more used → hotter). */
export function usageColor(usedPercent: number): string {
  if (usedPercent >= 90) return "#ff4d4f";
  if (usedPercent >= 75) return "#ffb02e";
  if (usedPercent >= 50) return "#ffd23f";
  return "#4ec9b0";
}
