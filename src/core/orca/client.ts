import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AttentionItem } from "../types.js";
import type { CommandRunner } from "../cmux/client.js";
import { normalizeWorktrees } from "./normalize.js";

const execFileAsync = promisify(execFile);

/** Common dirs Orca's CLI is installed into, to resolve a bare `orca`. */
const ORCA_DIRS = [
  "/Applications/Orca.app/Contents/Resources/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.HOME ? join(process.env.HOME, ".local/bin") : "",
].filter(Boolean);

const AUGMENTED_PATH = [...ORCA_DIRS, process.env.PATH ?? ""].filter(Boolean).join(":");

/** Resolve a (possibly bare) orca command to an absolute path. */
export function resolveOrcaBin(bin: string): string {
  if (isAbsolute(bin)) return bin;
  if (bin.includes("/")) return bin;
  for (const dir of ORCA_DIRS) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return bin;
}

const defaultRunner: CommandRunner = async (bin, args) => {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PATH: AUGMENTED_PATH },
  });
  return { stdout, stderr };
};

export interface OrcaClientOptions {
  bin?: string;
  runner?: CommandRunner;
  now?: () => number;
}

interface OrcaEnvelope<T> {
  ok?: unknown;
  result?: T;
}

/** Thin best-effort wrapper over the `orca` CLI. */
export class OrcaClient {
  private readonly bin: string;
  private readonly runner: CommandRunner;
  private readonly now: () => number;

  constructor(opts: OrcaClientOptions = {}) {
    this.bin = resolveOrcaBin(opts.bin ?? "orca");
    this.runner = opts.runner ?? defaultRunner;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Poll `worktree ps` and normalize to attention items. */
  async listAttention(): Promise<AttentionItem[]> {
    const { stdout } = await this.runner(this.bin, ["worktree", "ps", "--json"]);
    const env = JSON.parse(stdout) as OrcaEnvelope<{ worktrees?: unknown }>;
    const nowIso = new Date(this.now()).toISOString();
    return normalizeWorktrees(env.result?.worktrees, nowIso);
  }

  /** True when `orca status` reports a reachable runtime. */
  async reachable(): Promise<boolean> {
    try {
      const { stdout } = await this.runner(this.bin, ["status", "--json"]);
      const env = JSON.parse(stdout) as OrcaEnvelope<{ runtime?: { reachable?: unknown } }>;
      return env.ok === true && env.result?.runtime?.reachable === true;
    } catch {
      return false;
    }
  }

  /**
   * Focus an Orca worktree: resolve its most-recently-active terminal handle
   * and switch to it. There is no worktree-focus verb, so we go via a terminal.
   */
  async focus(item: AttentionItem): Promise<void> {
    const { stdout } = await this.runner(this.bin, ["terminal", "list", "--json"]);
    const env = JSON.parse(stdout) as OrcaEnvelope<{ terminals?: RawTerminal[] }>;
    const terminals = (env.result?.terminals ?? []).filter((t) => t.worktreeId === item.workspaceId);
    if (terminals.length === 0) throw new Error(`no live terminal for worktree ${item.workspaceId}`);
    const handle = terminals.reduce((a, b) => ((b.lastOutputAt ?? 0) > (a.lastOutputAt ?? 0) ? b : a)).handle;
    if (!handle) throw new Error(`no terminal handle for worktree ${item.workspaceId}`);
    await this.runner(this.bin, ["terminal", "focus", "--terminal", handle, "--json"]);
  }
}

interface RawTerminal {
  handle?: string;
  worktreeId?: string;
  lastOutputAt?: number;
}
