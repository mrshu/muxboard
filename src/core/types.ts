/**
 * Core domain types shared across the cmux and CodexBar layers.
 *
 * This module is intentionally dependency-free (no @elgato/streamdeck, no Node
 * built-ins) so it can be unit-tested and rendered headlessly with tsx.
 */

export type AgentKind = "claude" | "codex" | "pi" | "unknown";

export type AttentionReason =
  | "finished"
  | "failed"
  | "blocked"
  | "waiting"
  | "unknown";

/** A single cmux pane that needs the user's attention. */
export interface AttentionItem {
  /** cmux notification id (uuid). Used as the focus/open key. */
  id: string;
  agent: AgentKind;
  workspaceId: string;
  surfaceId?: string;
  /** Short repo/workspace name, derived from cmux tab_title. */
  repo?: string;
  /** Human-facing label for the key. */
  title: string;
  reason: AttentionReason;
  /** Raw notification body (used for the reason mapping + hints). */
  body: string;
  /** ISO-8601 creation timestamp (sort key). */
  createdAt: string;
}

/** A usage window (session or weekly) for a CodexBar provider. */
export interface UsageWindow {
  /** Percentage of the quota already used, 0..100. */
  usedPercent: number;
  /** Convenience: 100 - usedPercent, clamped to 0..100. */
  remainingPercent: number;
  /** ISO-8601 reset timestamp, when known. */
  resetsAt?: string;
  /** Human reset description from CodexBar (e.g. "Resets in 5h"). */
  resetDescription?: string;
  /** Window length in minutes (300 = session/5h, 10080 = weekly/7d). */
  windowMinutes?: number;
}

/** Normalized CodexBar usage for one provider. */
export interface ProviderUsage {
  provider: string;
  account?: string;
  /** primary window. */
  session?: UsageWindow;
  /** secondary window. */
  weekly?: UsageWindow;
  /** Today's spend in EUR, from /cost (optional). */
  costTodayEur?: number;
  /** ISO-8601 of when CodexBar last refreshed this payload. */
  updatedAt?: string;
  /** True when the payload was usable; false on error/unreachable. */
  ok: boolean;
  error?: string;
}

/** Agent filter applied to the attention queue (dial 2). */
export type AgentFilter = "all" | AgentKind;

/** Whole-plugin runtime state held by the store. */
export interface AppState {
  /** Newest-first attention items (already filtered+sorted). */
  items: AttentionItem[];
  /** Unfiltered, newest-first — kept so filter changes are cheap. */
  allItems: AttentionItem[];
  /** Scroll offset into items for the 8-key window (dial 1). */
  offset: number;
  /** Active agent filter (dial 2). */
  filter: AgentFilter;
  /** True when the cmux feed is currently unavailable. */
  cmuxOffline: boolean;
  /** CodexBar usage per provider, keyed by provider id. */
  usage: Record<string, ProviderUsage>;
  /** Providers shown across the LCD segments, in display order. */
  providers: string[];
  /** Epoch ms of the last successful CodexBar refresh. */
  codexbarUpdatedAtMs: number | null;
  /** True when CodexBar serve is unreachable. */
  codexbarOffline: boolean;
}
