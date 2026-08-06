import { type AgentKind, toAgentKind } from "../types.js";
import { type Activity, forEachWorkspace, hasSpinnerGlyph, walk } from "./workspaces.js";

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

  // Walk to each workspace; within one, the first root_pid matching an agent
  // wins. `found` is per-occurrence, not per-id: should the same id appear in
  // two windows, the last occurrence still overwrites, as it always has.
  forEachWorkspace(top, (ws) => {
    const id = ws.id;
    if (typeof id !== "string") return;
    let found: AgentKind | undefined;
    walk(ws, (n) => {
      if (found || !Array.isArray(n.root_pids)) return;
      for (const p of n.root_pids) {
        const agent = typeof p === "number" ? pidToAgent.get(p) : undefined;
        if (agent) {
          found = agent;
          return;
        }
      }
    });
    if (found) out.set(id, found);
  });
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
  forEachWorkspace(topRaw, (ws) => {
    const id = ws.id;
    if (typeof id !== "string") return;
    walk(ws, (n) => {
      if (typeof n.title === "string" && hasSpinnerGlyph(n.title)) out.set(id, "working");
    });
  });
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
  walk(topRaw, (n) => {
    if (n.kind !== "workspace" || typeof n.id !== "string") return;
    const res = n.resources as { cpu_percent?: unknown } | undefined;
    out.set(n.id, typeof res?.cpu_percent === "number" ? res.cpu_percent : 0);
  });
  return out;
}
