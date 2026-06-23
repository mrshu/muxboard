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
  error?: { code?: unknown; message?: unknown };
}

/**
 * Parse an `orca` CLI JSON envelope and return its result, throwing on a logical
 * failure. The CLI exits 0 even on errors, signaling them only via `ok:false`,
 * so a caller that ignored `ok` would treat an error envelope as success — an
 * empty attention list that clobbers the last-good slice, or a "focus" that
 * silently did nothing. Best-effort callers (reachable) catch instead.
 */
function requireOk<T>(stdout: string, what: string): OrcaEnvelope<T> {
  let env: OrcaEnvelope<T>;
  try {
    env = JSON.parse(stdout) as OrcaEnvelope<T>;
  } catch {
    throw new Error(`orca ${what}: non-JSON response`);
  }
  if (env.ok !== true) {
    const detail = env.error
      ? `${String(env.error.code ?? "")} ${String(env.error.message ?? "")}`.trim()
      : "ok:false";
    throw new Error(`orca ${what} failed: ${detail}`);
  }
  return env;
}

/** Like requireOk but also requires a present `result` (commands we read from). */
function unwrap<T>(stdout: string, what: string): T {
  const env = requireOk<T>(stdout, what);
  if (env.result == null) throw new Error(`orca ${what}: missing result`);
  return env.result;
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
    const result = unwrap<{ worktrees?: unknown }>(stdout, "worktree ps");
    if (!Array.isArray(result.worktrees)) {
      throw new Error("orca worktree ps: result.worktrees is not an array");
    }
    const nowIso = new Date(this.now()).toISOString();
    return normalizeWorktrees(result.worktrees, nowIso);
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
    // Scope the lookup to this worktree server-side (verified to accept the
    // composite worktree id) so a busy runtime doesn't return every terminal,
    // then re-filter defensively.
    const { stdout } = await this.runner(this.bin, [
      "terminal",
      "list",
      "--worktree",
      `id:${item.workspaceId}`,
      "--json",
    ]);
    const result = unwrap<{ terminals?: RawTerminal[] }>(stdout, "terminal list");
    const terminals = (result.terminals ?? []).filter((t) => t.worktreeId === item.workspaceId);
    if (terminals.length === 0) throw new Error(`no live terminal for worktree ${item.workspaceId}`);
    const handle = terminals.reduce((a, b) => ((b.lastOutputAt ?? 0) > (a.lastOutputAt ?? 0) ? b : a)).handle;
    if (!handle) throw new Error(`no terminal handle for worktree ${item.workspaceId}`);
    const { stdout: focusOut } = await this.runner(this.bin, [
      "terminal",
      "focus",
      "--terminal",
      handle,
      "--json",
    ]);
    requireOk(focusOut, "terminal focus");
  }
}

interface RawTerminal {
  handle?: string;
  worktreeId?: string;
  lastOutputAt?: number;
}
