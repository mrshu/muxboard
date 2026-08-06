import { str } from "../types.js";

/** Whether the agent is actively working vs idle/waiting for you. */
export type Activity = "working" | "waiting";

/** Per-workspace context resolved from `cmux workspace list`. */
export interface WorkspaceInfo {
  /** Best human title: custom_title → cleaned title → basename(cwd). */
  title: string;
  /** The workspace's cmux color (custom_color hex), used for the key border. */
  color?: string;
  /** Activity inferred from the title's status glyph (spinner = working). */
  activity: Activity;
}

/**
 * True iff a title leads with cmux's animated braille spinner (U+2800–U+28FF),
 * which cmux shows ONLY while the agent is actively working. A leading ✳
 * (U+2733) is cmux's idle/waiting marker and deliberately does NOT match — it
 * would otherwise flag every idle Claude pane as working. Shared by the
 * workspace-title heuristic and the per-surface-title check in agents.ts.
 */
export function hasSpinnerGlyph(title: string): boolean {
  return /^\s*[⠀-⣿]/.test(title);
}

/**
 * Infer activity from a raw title's leading status glyph: cmux prepends an
 * animated braille spinner (U+2800–U+28FF) while the agent is actively working,
 * and a ✳ (or nothing) when it's idle/waiting for you.
 */
export function detectActivity(rawTitle: string): Activity {
  return hasSpinnerGlyph(rawTitle) ? "working" : "waiting";
}

/** Strip cmux's leading spinner/✳ status glyphs and collapse whitespace. */
export function cleanTitle(s: string): string {
  return s
    .replace(/^[\s⠀-⣿✳️*✳]+/u, "") // braille spinner frames, ✳, VS16, *
    .replace(/\s+/g, " ")
    .trim();
}

export const basename = (p: string): string => {
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
};

/** Any object node in a parsed-JSON tree. */
type JsonNode = Record<string, unknown>;

/**
 * Depth-first (pre-order) walk over every object node in a parsed-JSON tree.
 * cmux nests workspaces/panes/surfaces differently across versions, so the
 * parsers scan for the fields they need rather than hard-coding a path.
 */
export function walk(node: unknown, fn: (n: JsonNode) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as JsonNode;
  fn(n);
  for (const key of Object.keys(n)) walk(n[key], fn);
}

/** Call `fn` for every workspace object found in any `workspaces` array. */
export function forEachWorkspace(root: unknown, fn: (ws: JsonNode) => void): void {
  walk(root, (n) => {
    if (!Array.isArray(n.workspaces)) return;
    for (const w of n.workspaces) if (w && typeof w === "object") fn(w as JsonNode);
  });
}

/** Pick the best display title for a workspace record. */
function resolveTitle(ws: Record<string, unknown>): string {
  const custom = str(ws.custom_title);
  if (custom && (ws.has_custom_title === true || ws.has_custom_title === "true")) return cleanTitle(custom);
  const title = cleanTitle(str(ws.title));
  const cwd = str(ws.current_directory);
  // Path-like titles ("~/w/d/m/harbor", "…/dev/…") read better as the basename.
  if (!title || /^[~…/]/.test(title)) return cwd ? basename(cwd) : title;
  return title;
}

/**
 * Parse `cmux --id-format uuids workspace list --json` into workspaceId → info.
 * Output is `{ window_ref, workspaces: [...] }` per window; each workspace's
 * `ref` is the UUID under --id-format uuids.
 */
export function parseWorkspaceInfo(raw: unknown): Map<string, WorkspaceInfo> {
  const out = new Map<string, WorkspaceInfo>();
  forEachWorkspace(raw, (ws) => {
    // `ref` wins when present, even empty — an empty ref drops the row, as before.
    const id = typeof ws.ref === "string" ? ws.ref : str(ws.id);
    if (!id) return;
    const hex = str(ws.custom_color);
    out.set(id, {
      title: resolveTitle(ws),
      color: /^#[0-9a-f]{6}$/i.test(hex) ? hex : undefined,
      activity: detectActivity(str(ws.title)),
    });
  });
  return out;
}
