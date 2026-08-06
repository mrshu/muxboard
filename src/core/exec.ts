import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Pluggable command runner so the CLI clients can be unit-tested without the tool. */
export type CommandRunner = (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * The dirs a Mac CLI is typically installed into: its own app bundle first,
 * then Homebrew (both architectures) and the user's ~/.local/bin.
 */
export function installDirs(appBinDir: string): string[] {
  return [
    appBinDir,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.HOME ? join(process.env.HOME, ".local/bin") : "",
  ].filter(Boolean);
}

/**
 * Resolve a (possibly bare) command to an absolute path.
 *
 * The Stream Deck app launches the plugin with a minimal PATH, and Node's
 * execFile resolves bare commands against the parent's process.env.PATH (not a
 * custom env.PATH), so a bare `cmux`/`orca` is not found. We therefore resolve
 * the absolute path against known install dirs ourselves. Absolute/explicitly
 * relative inputs are returned as-is; if nothing resolves we fall back to the
 * bare name (which still works in a normal shell with the tool on PATH).
 */
export function resolveBin(bin: string, dirs: string[]): string {
  if (isAbsolute(bin) || bin.includes("/")) return bin; // explicit path: respect it
  for (const dir of dirs) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return bin;
}

/**
 * Spawn environment for a CLI: PATH augmented with its install dirs, so a bare
 * command resolves under the Stream Deck app's minimal PATH. `extra` carries
 * any tool-specific vars.
 */
export function execEnv(dirs: string[], extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, PATH: [...dirs, process.env.PATH ?? ""].filter(Boolean).join(":"), ...extra };
}
