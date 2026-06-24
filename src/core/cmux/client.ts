import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AgentKind, AttentionItem, WorkspaceStatus } from "../types.js";
import {
  type AgentAliases,
  buildRunningItems,
  normalizeNotifications,
  unreadNotifications,
} from "./normalize.js";
import { parseCodingAgents, parseWorkspaceCpu } from "./agents.js";
import { parseWorkspaceInfo, type WorkspaceInfo } from "./workspaces.js";

const execFileAsync = promisify(execFile);

/** Common directories cmux is installed into, used to resolve a bare name. */
const CMUX_DIRS = [
  "/Applications/cmux.app/Contents/Resources/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.HOME ? join(process.env.HOME, ".local/bin") : "",
].filter(Boolean);

/**
 * Resolve a (possibly bare) cmux command to an absolute path.
 *
 * The Stream Deck app launches the plugin with a minimal PATH, and Node's
 * execFile resolves bare commands against the parent's process.env.PATH (not a
 * custom env.PATH), so a bare `cmux` is not found. We therefore resolve the
 * absolute path against known install dirs ourselves. Absolute/existing inputs
 * are returned as-is; if nothing resolves we fall back to the bare name (which
 * still works in a normal shell with cmux on PATH).
 */
export function resolveCmuxBin(bin: string): string {
  if (isAbsolute(bin)) return bin;
  if (bin.includes("/")) return bin; // explicit relative path: respect it
  for (const dir of CMUX_DIRS) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return bin;
}

/** Result of running a cmux subcommand. */
export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Pluggable command runner so the client can be unit-tested without cmux. */
export type CommandRunner = (bin: string, args: string[]) => Promise<RunResult>;

/**
 * PATH augmented with common cmux/Homebrew locations.
 *
 * The Stream Deck app launches the plugin with a minimal PATH that omits the
 * cmux app bundle, so a bare `cmux` is "command not found". Prepending the usual
 * install dirs lets the bare command resolve without hard-coding one path.
 */
const AUGMENTED_PATH = [
  "/Applications/cmux.app/Contents/Resources/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.HOME ? `${process.env.HOME}/.local/bin` : "",
  process.env.PATH ?? "",
]
  .filter(Boolean)
  .join(":");

/**
 * Environment for spawning cmux: the augmented PATH (so a bare `cmux` resolves
 * under the Stream Deck app's minimal PATH) plus CMUX_QUIET to keep stdout
 * clean. Shared by the exec-based client and the long-lived events stream.
 */
export function cmuxEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: AUGMENTED_PATH, CMUX_QUIET: "1" };
}

const defaultRunner: CommandRunner = async (bin, args) => {
  // 10s ceiling: cmux list/focus calls are fast; a hang must not wedge the loop.
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    // CMUX_QUIET silences legacy-alias notices that would corrupt JSON output.
    env: { ...process.env, PATH: AUGMENTED_PATH, CMUX_QUIET: "1" },
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
  private readonly busyCpuPercent: number;
  /** workspaceId → epoch ms it last exceeded the busy threshold (hysteresis). */
  private readonly lastBusyAt: Map<string, number> = new Map();
  /** workspaceId → epoch ms the current busy window started (the "since" clock). */
  private readonly busySince: Map<string, number> = new Map();
  /** Keep a pane "busy" this long after CPU drops, so bursty commands don't flicker. */
  private static readonly BUSY_GRACE_MS = 30_000;
  /** Cached workspace→info map (title + message, from `workspace list`). */
  private wsCache: Map<string, WorkspaceInfo> = new Map();
  private wsCacheAt = 0;
  private readonly now: () => number;
  private static readonly AGENT_TTL_MS = 5000;
  private static readonly MSG_TTL_MS = 3000;

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
    // Drop notifications the user has already acted on (cmux only flips
    // `is_read`, never removes the row) so a long-cleared prompt doesn't linger
    // as a stale key.
    const items = normalizeNotifications(unreadNotifications(parsed), this.aliases, {
      agents,
      workspaces,
      busyWorkspaces: this.busyWorkspaces(),
    });
    // Append actively-working agent panes that have no notification, so they're
    // listed (at the end, via triage). Skip workspaces already on a key.
    const covered = new Set(items.map((i) => i.workspaceId));
    const running = buildRunningItems(
      workspaces,
      agents,
      covered,
      new Date(this.now()).toISOString(),
      status,
    );
    return [...items, ...running];
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
      if (cpu >= this.busyCpuPercent) {
        this.lastBusyAt.set(id, now);
        if (!this.busySince.has(id)) this.busySince.set(id, now); // window start
      }
    }
    const out = new Map<string, number>();
    for (const [id, at] of this.lastBusyAt) {
      if (now - at <= CmuxClient.BUSY_GRACE_MS) {
        out.set(id, this.busySince.get(id) ?? at);
      } else {
        this.lastBusyAt.delete(id);
        this.busySince.delete(id);
      }
    }
    return out;
  }

  /**
   * Map of workspaceId → info (best title + latest message), from
   * `cmux workspace list`. The title is what each key shows; the message is a
   * fallback. Cached briefly; best-effort.
   */
  async workspaceInfo(): Promise<Map<string, WorkspaceInfo>> {
    if (this.now() - this.wsCacheAt < CmuxClient.MSG_TTL_MS) return this.wsCache;
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
  async codingAgentsByWorkspace(): Promise<Map<string, AgentKind>> {
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
   * Dismiss (remove) a notification by id, e.g. "seen it, nothing further".
   * The pane leaves the queue on the next poll.
   */
  async dismissNotification(id: string): Promise<void> {
    await this.runner(this.bin, ["dismiss-notification", "--id", id]);
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

  /** True when the cmux CLI responds to `ping`. */
  async ping(): Promise<boolean> {
    try {
      await this.runner(this.bin, ["ping"]);
      return true;
    } catch {
      return false;
    }
  }
}
