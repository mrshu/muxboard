import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentKind, AttentionItem, WorkspaceStatus } from "../types.js";
import { type CommandRunner, execEnv, installDirs, resolveBin } from "../exec.js";
import { type AgentAliases, buildRunningItems, normalizeNotifications } from "./normalize.js";
import { parseCodingAgents, parseSurfaceActivity, parseWorkspaceCpu } from "./agents.js";
import { type Activity, parseWorkspaceInfo, type WorkspaceInfo } from "./workspaces.js";

const execFileAsync = promisify(execFile);

const CMUX_DIRS = installDirs("/Applications/cmux.app/Contents/Resources/bin");

/** Resolve a (possibly bare) cmux command against the known install dirs. */
export function resolveCmuxBin(bin: string): string {
  return resolveBin(bin, CMUX_DIRS);
}

/**
 * Environment for spawning cmux: the augmented PATH (so a bare `cmux` resolves
 * under the Stream Deck app's minimal PATH) plus CMUX_QUIET to keep stdout
 * clean — it silences legacy-alias notices that would otherwise land on stdout
 * and corrupt the JSON these commands emit. Shared by the exec-based client and
 * the long-lived events stream.
 */
export function cmuxEnv(): NodeJS.ProcessEnv {
  return execEnv(CMUX_DIRS, { CMUX_QUIET: "1" });
}

const defaultRunner: CommandRunner = async (bin, args) => {
  // 10s ceiling: cmux list/focus calls are fast; a hang must not wedge the loop.
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    env: cmuxEnv(),
  });
  return { stdout, stderr };
};

export interface CmuxClientOptions {
  /** cmux binary path or name. Defaults to "cmux". */
  bin?: string;
  /** Injected runner for tests; defaults to execFile. */
  runner?: CommandRunner;
  /** Custom-name → agent map applied during normalization. */
  agentAliases?: AgentAliases;
  /** Epoch-ms clock, injectable for tests (agent-cache TTL). */
  now?: () => number;
  /** Workspace CPU% at/above which a pane counts as "busy" (command running). */
  busyCpuPercent?: number;
}

/**
 * Thin wrapper over the cmux CLI.
 *
 * Every method is best-effort: failures throw and are caught by the polling
 * service, which keeps the last good state rather than crashing.
 */
export class CmuxClient {
  private readonly bin: string;
  private readonly runner: CommandRunner;
  private readonly aliases: AgentAliases;
  /** Cached workspace→agent map (from `top`), refreshed on a slow cadence. */
  private agentCache: Map<string, AgentKind> = new Map();
  private agentCacheAt = 0;
  /** Cached workspace→CPU% map (from the same `top` call). */
  private cpuCache: Map<string, number> = new Map();
  /** Cached workspace→"working" map from per-surface spinner glyphs (same `top`). */
  private surfaceCache: Map<string, Activity> = new Map();
  private readonly busyCpuPercent: number;
  /** workspaceId → { since: busy-window start, last: last time CPU exceeded the threshold }. */
  private readonly busy = new Map<string, { since: number; last: number }>();
  /** Keep a pane "busy" this long after CPU drops, so bursty commands don't flicker. */
  private static readonly BUSY_GRACE_MS = 30_000;
  /** Cached workspace→info map (title + message, from `workspace list`). */
  private wsCache: Map<string, WorkspaceInfo> = new Map();
  private wsCacheAt = 0;
  private readonly now: () => number;
  private static readonly AGENT_TTL_MS = 5000;
  private static readonly WS_TTL_MS = 3000;

  constructor(opts: CmuxClientOptions = {}) {
    this.bin = resolveCmuxBin(opts.bin ?? "cmux");
    this.runner = opts.runner ?? defaultRunner;
    this.aliases = opts.agentAliases ?? {};
    this.now = opts.now ?? (() => Date.now());
    this.busyCpuPercent = opts.busyCpuPercent ?? 40;
  }

  /**
   * Fetch and normalize the current attention queue.
   *
   * `status` is the live per-workspace status from the event stream (passed in
   * by the poll service). It is the authoritative "running" signal used to
   * synthesize notification-less working panes, since cmux's title spinner is
   * absent for custom-titled workspaces.
   */
  async listAttention(status: Record<string, WorkspaceStatus> = {}): Promise<AttentionItem[]> {
    const [{ stdout }, agents, workspaces] = await Promise.all([
      this.runner(this.bin, ["list-notifications", "--json"]),
      this.codingAgentsByWorkspace(),
      this.workspaceInfo(),
    ]);
    const parsed = JSON.parse(stdout) as unknown;
    const enriched = this.applySurfaceActivity(workspaces, agents);
    const items = normalizeNotifications(parsed, this.aliases, {
      agents,
      workspaces: enriched,
      busyWorkspaces: this.busyWorkspaces(),
    });
    // Append actively-working agent panes that have no notification, so they're
    // listed (at the end, via triage). Skip workspaces already on a key.
    const covered = new Set(items.map((i) => i.workspaceId));
    const running = buildRunningItems(
      enriched,
      agents,
      covered,
      new Date(this.now()).toISOString(),
      status,
    );
    return [...items, ...running];
  }

  /**
   * Overlay the per-surface spinner signal onto the workspace-list info.
   *
   * `cmux workspace list` only carries the (glyph-stripped) workspace title, so a
   * custom-titled agent that is actively working but emits no event-stream hooks
   * reads as "waiting". The live braille spinner survives on that pane's surface
   * title (from `cmux top`), so we upgrade such a workspace's activity to
   * "working". Scoped to workspaces cmux identifies as coding agents, so a plain
   * command pane with a spinner-style CLI doesn't get mislabelled an agent. The
   * event-stream verdict still wins downstream (store.applyStatus forces
   * working=false on a live needs/idle state).
   */
  private applySurfaceActivity(
    workspaces: Map<string, WorkspaceInfo>,
    agents: Map<string, AgentKind>,
  ): Map<string, WorkspaceInfo> {
    const out = new Map(workspaces);
    for (const [id, ws] of workspaces) {
      if (ws.activity !== "working" && agents.has(id) && this.surfaceCache.get(id) === "working") {
        out.set(id, { ...ws, activity: "working" });
      }
    }
    return out;
  }

  /**
   * Workspaces with a command running, by CPU from the cached `top`, mapped to
   * when the current busy window *started*. Hysteresis: a pane stays "busy" for
   * a grace window after CPU drops, so a bursty command (a test loop, a build)
   * reads as continuously working instead of flickering between bursts — and the
   * busy-since clock survives the gaps.
   *
   * This is the one "working" signal that does NOT depend on cmux's agent hooks,
   * so it stays correct (with a fresh timestamp) even when the hook stream is
   * stale or absent.
   */
  private busyWorkspaces(): Map<string, number> {
    const now = this.now();
    for (const [id, cpu] of this.cpuCache) {
      if (cpu < this.busyCpuPercent) continue;
      const win = this.busy.get(id);
      if (win) win.last = now;
      else this.busy.set(id, { since: now, last: now }); // new busy window
    }
    const out = new Map<string, number>();
    for (const [id, win] of this.busy) {
      if (now - win.last <= CmuxClient.BUSY_GRACE_MS) out.set(id, win.since);
      else this.busy.delete(id);
    }
    return out;
  }

  /**
   * Map of workspaceId → info (best title, color, activity), from
   * `cmux workspace list`. The title is what each key shows. Cached briefly;
   * best-effort.
   */
  private async workspaceInfo(): Promise<Map<string, WorkspaceInfo>> {
    if (this.now() - this.wsCacheAt < CmuxClient.WS_TTL_MS) return this.wsCache;
    try {
      const { stdout } = await this.runner(this.bin, [
        "--id-format",
        "uuids",
        "workspace",
        "list",
        "--json",
      ]);
      this.wsCache = parseWorkspaceInfo(JSON.parse(stdout));
      this.wsCacheAt = this.now();
    } catch {
      // Keep last cache; tab/body fallbacks cover the gap.
    }
    return this.wsCache;
  }

  /**
   * Map of workspaceId → agent, derived from the actual running process via
   * `cmux top --processes`. This is the authoritative agent identity (a codex
   * CLI in a pane named "fieldtheory-cli" is still detected as codex). Cached
   * for a few seconds since the running agent rarely changes, and best-effort:
   * on failure we return the last cache (or empty) so the title heuristic wins.
   */
  private async codingAgentsByWorkspace(): Promise<Map<string, AgentKind>> {
    if (this.now() - this.agentCacheAt < CmuxClient.AGENT_TTL_MS) return this.agentCache;
    try {
      const { stdout } = await this.runner(this.bin, [
        "--json",
        "--id-format",
        "uuids",
        "top",
        "--processes",
        "--all",
      ]);
      const top = JSON.parse(stdout);
      this.agentCache = parseCodingAgents(top);
      this.cpuCache = parseWorkspaceCpu(top);
      this.surfaceCache = parseSurfaceActivity(top);
      this.agentCacheAt = this.now();
    } catch {
      // Keep the last cache; the title/alias heuristic covers the gap.
    }
    return this.agentCache;
  }

  /**
   * Focus the workspace + surface behind a notification.
   *
   * Uses `cmux open-notification --id`, cmux's blessed jump primitive, which
   * marks the row read but does NOT clear/dismiss it.
   */
  async openNotification(id: string): Promise<void> {
    await this.runner(this.bin, ["open-notification", "--id", id]);
  }

  /**
   * Fallback focus path used only when open-notification fails.
   *
   * cmux has no `focus-surface` command (surfaces are focused via their pane or
   * via open-notification), so the best we can do from a notification — which
   * only carries workspace_id + surface_id — is to select the workspace.
   */
  async selectWorkspace(workspaceId: string): Promise<void> {
    await this.runner(this.bin, ["select-workspace", "--workspace", workspaceId]);
  }
}
