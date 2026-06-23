/**
 * Core domain types shared across the cmux and CodexBar layers.
 *
 * This module is intentionally dependency-free (no @elgato/streamdeck, no Node
 * built-ins) so it can be unit-tested and rendered headlessly with tsx.
 */

export type AgentKind = "claude" | "codex" | "pi" | "unknown";

/** Which backend an attention item originates from. */
export type AttentionSource = "cmux" | "orca";

/** Live workspace state from cmux's agent event stream (set_status mirror). */
export type WorkspaceState = "running" | "needs" | "idle";

/** A workspace's current state plus when it entered that state (epoch ms). */
export interface WorkspaceStatus {
  state: WorkspaceState;
  since: number;
}

export type AttentionReason =
  | "finished"
  | "failed"
  | "blocked"
  | "waiting"
  | "unknown";

/** A single pane/worktree that needs the user's attention (cmux or Orca). */
export interface AttentionItem {
  /**
   * Unique item id and focus key. For cmux: the notification uuid. For Orca:
   * the worktree id (a composite `repoId::path`, not a uuid).
   */
  id: string;
  /** The backend this item came from (cmux notification vs Orca worktree). */
  source: AttentionSource;
  agent: AgentKind;
  workspaceId: string;
  surfaceId?: string;
  /** Short repo/workspace name, derived from cmux tab_title. */
  repo?: string;
  /** Human-facing label for the key. */
  title: string;
  reason: AttentionReason;
  /** Whether the agent is actively working vs idle/waiting for you. */
  activity: "working" | "waiting";
  /**
   * True when the workspace has a busy command running (high process CPU from
   * `cmux top`), even if the agent itself has gone idle. Counts as "working".
   */
  busy?: boolean;
  /** Epoch ms the current busy window started (drives the age when busy). */
  busySince?: number;
  /**
   * True when cmux's live status for the workspace is "Needs" (the agent is
   * waiting on you for input/a choice). Shown more prominently than plain
   * waiting, and pinned above it.
   */
  needsInput?: boolean;
  /**
   * Epoch ms the current activity began, from the cmux event stream when
   * available. Drives the key's age display so it reflects the live state
   * ("working for 2m") instead of the (possibly stale) notification time.
   */
  activitySince?: number;
  /** The workspace's cmux color (hex), used for the key border. */
  color?: string;
  /** Raw notification body (used for the reason mapping + hints). */
  body: string;
  /** Best human content for the key band: the agent/pane's last message. */
  message: string;
  /** ISO-8601 creation timestamp (sort key). */
  createdAt: string;
  /**
   * True for a pane added because it's actively working but has no notification
   * (a "running" item, listed at the end). Pressing it focuses the workspace
   * directly rather than opening a notification.
   */
  synthetic?: boolean;
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
  /** True when the Orca feed is currently unavailable. */
  orcaOffline: boolean;
  /** True once the Orca poller has been started (auto-detected reachable). */
  orcaActive: boolean;
  /** CodexBar usage per provider, keyed by provider id. */
  usage: Record<string, ProviderUsage>;
  /** Live per-workspace status from the cmux event stream, keyed by id. */
  workspaceStatus: Record<string, WorkspaceStatus>;
  /** Providers shown across the LCD segments, in display order. */
  providers: string[];
  /**
   * Rotation offset into `providers` for the LCD window (dial 3). Only moves
   * when there are more providers than segments; otherwise pinned to 0.
   */
  providerOffset: number;
  /** Epoch ms of the last successful CodexBar refresh. */
  codexbarUpdatedAtMs: number | null;
  /** True when CodexBar serve is unreachable. */
  codexbarOffline: boolean;
}
