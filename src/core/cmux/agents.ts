import type { AgentKind } from "../types.js";
import { type Activity, hasSpinnerGlyph } from "./workspaces.js";

/**
 * Map a cmux coding-agent id to our AgentKind. cmux reports canonical ids
 * (codex, claude, gemini, opencode, grok, pi, …); we render claude/codex/pi
 * with branded visuals and everything else as a neutral "unknown".
 */
export function toAgentKind(id: string): AgentKind {
  const k = id.toLowerCase();
  if (k === "claude") return "claude";
  if (k === "codex") return "codex";
  if (k === "pi") return "pi";
  return "unknown";
}

/**
 * Build a workspaceId → agent map from `cmux --json --id-format uuids top
 * --processes --all` output.
 *
 * cmux exposes a top-level `coding_agents` array ({id, resources.pids}) — the
 * authoritative agent identity from the actual running process, regardless of
 * how the pane/tab is named. We match each agent's PIDs against the per-surface
 * `root_pids` in the `windows` tree to resolve which workspace runs it.
 */
export function parseCodingAgents(topRaw: unknown): Map<string, AgentKind> {
  const out = new Map<string, AgentKind>();
  if (!topRaw || typeof topRaw !== "object") return out;
  const top = topRaw as { coding_agents?: unknown; windows?: unknown };

  // pid → agent kind
  const pidToAgent = new Map<number, AgentKind>();
  if (Array.isArray(top.coding_agents)) {
    for (const a of top.coding_agents) {
      if (!a || typeof a !== "object") continue;
      const id = typeof (a as { id?: unknown }).id === "string" ? (a as { id: string }).id : "";
      const pids = (a as { resources?: { pids?: unknown } }).resources?.pids;
      if (!id || !Array.isArray(pids)) continue;
      const kind = toAgentKind(id);
      for (const p of pids) if (typeof p === "number") pidToAgent.set(p, kind);
    }
  }
  if (pidToAgent.size === 0) return out;

  // Walk to each workspace; collect every root_pid under it; match an agent.
  const collectPids = (node: unknown, acc: number[]): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.root_pids)) {
      for (const p of n.root_pids) if (typeof p === "number") acc.push(p);
    }
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (v && typeof v === "object") collectPids(v, acc);
    }
  };

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.workspaces)) {
      for (const w of n.workspaces) {
        if (!w || typeof w !== "object") continue;
        const id = (w as { id?: unknown }).id;
        if (typeof id !== "string") continue;
        const pids: number[] = [];
        collectPids(w, pids);
        for (const p of pids) {
          const agent = pidToAgent.get(p);
          if (agent) {
            out.set(id, agent);
            break;
          }
        }
      }
    }
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (v && typeof v === "object") visit(v);
    }
  };
  visit(top);
  return out;
}

/**
 * Build a workspaceId → "working" map from the per-surface titles in `cmux top`.
 *
 * cmux strips the spinner glyph from a workspace's *own* JSON title once it has
 * a custom title, so the workspace-title heuristic (detectActivity) is blind to
 * every custom-titled pane. But the live braille spinner survives on the pane's
 * *surface* title (`panes[].surfaces[].title`), so a custom-titled agent that
 * emits no event-stream hooks (e.g. a `claude` launched by hand outside cmux's
 * hook-injecting wrapper) is still visibly working here. A workspace counts as
 * working if ANY of its surface titles carries the spinner. We scan every
 * descendant title under a workspace, so the exact pane/surface nesting doesn't
 * matter; non-spinner titles (and the ✳ idle marker) never match.
 */
export function parseSurfaceActivity(topRaw: unknown): Map<string, Activity> {
  const out = new Map<string, Activity>();

  const collectTitles = (node: unknown, acc: string[]): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.title === "string") acc.push(n.title);
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (v && typeof v === "object") collectTitles(v, acc);
    }
  };

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.workspaces)) {
      for (const w of n.workspaces) {
        if (!w || typeof w !== "object") continue;
        const id = (w as { id?: unknown }).id;
        if (typeof id !== "string") continue;
        const titles: string[] = [];
        collectTitles(w, titles);
        if (titles.some(hasSpinnerGlyph)) out.set(id, "working");
      }
    }
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (v && typeof v === "object") visit(v);
    }
  };

  visit(topRaw);
  return out;
}

/**
 * Build a workspaceId → CPU-percent map from the same `cmux top` JSON.
 *
 * Each workspace node carries `resources.cpu_percent` aggregating all its
 * processes (summed across cores, so a busy multi-process command reads in the
 * hundreds). This is the signal for "a command is running here" even when the
 * agent itself has gone idle and is waiting for you.
 */
export function parseWorkspaceCpu(topRaw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.kind === "workspace" && typeof n.id === "string") {
      const res = n.resources as { cpu_percent?: unknown } | undefined;
      out.set(n.id, typeof res?.cpu_percent === "number" ? res.cpu_percent : 0);
    }
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (v && typeof v === "object") visit(v);
    }
  };
  visit(topRaw);
  return out;
}
