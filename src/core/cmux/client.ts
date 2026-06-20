import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AttentionItem } from "../types.js";
import { normalizeNotifications } from "./normalize.js";

const execFileAsync = promisify(execFile);

/** Result of running a cmux subcommand. */
export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Pluggable command runner so the client can be unit-tested without cmux. */
export type CommandRunner = (bin: string, args: string[]) => Promise<RunResult>;

const defaultRunner: CommandRunner = async (bin, args) => {
  // 10s ceiling: cmux list/focus calls are fast; a hang must not wedge the loop.
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout, stderr };
};

export interface CmuxClientOptions {
  /** cmux binary path or name. Defaults to "cmux". */
  bin?: string;
  /** Injected runner for tests; defaults to execFile. */
  runner?: CommandRunner;
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

  constructor(opts: CmuxClientOptions = {}) {
    this.bin = opts.bin ?? "cmux";
    this.runner = opts.runner ?? defaultRunner;
  }

  /** Fetch and normalize the current attention queue. */
  async listAttention(): Promise<AttentionItem[]> {
    const { stdout } = await this.runner(this.bin, ["list-notifications", "--json"]);
    const parsed = JSON.parse(stdout) as unknown;
    return normalizeNotifications(parsed);
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
