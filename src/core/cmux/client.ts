import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AgentKind, AttentionItem } from "../types.js";
import { type AgentAliases, normalizeNotifications } from "./normalize.js";
import { parseCodingAgents } from "./agents.js";
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
  }

  /** Fetch and normalize the current attention queue. */
  async listAttention(): Promise<AttentionItem[]> {
    const [{ stdout }, agents, workspaces] = await Promise.all([
      this.runner(this.bin, ["list-notifications", "--json"]),
      this.codingAgentsByWorkspace(),
      this.workspaceInfo(),
    ]);
    const parsed = JSON.parse(stdout) as unknown;
    return normalizeNotifications(parsed, this.aliases, { agents, workspaces });
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
      this.agentCache = parseCodingAgents(JSON.parse(stdout));
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
