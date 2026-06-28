/** Whether the agent is actively working vs idle/waiting for you. */
export type Activity = "working" | "waiting";

/** Per-workspace context resolved from `cmux workspace list`. */
export interface WorkspaceInfo {
  /** Best human title: custom_title → cleaned title → basename(cwd). */
  title: string;
  /** The pane's latest conversation message (optional fallback content). */
  message: string;
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

const basename = (p: string): string => {
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
};

/** Pick the best display title for a workspace record. */
function resolveTitle(ws: Record<string, unknown>): string {
  const custom = typeof ws.custom_title === "string" ? ws.custom_title : "";
  if (ws.has_custom_title === true || ws.has_custom_title === "true") {
    if (custom) return cleanTitle(custom);
  }
  const title = cleanTitle(typeof ws.title === "string" ? ws.title : "");
  const cwd = typeof ws.current_directory === "string" ? ws.current_directory : "";
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
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.workspaces)) {
      for (const w of n.workspaces) {
        if (!w || typeof w !== "object") continue;
        const ws = w as Record<string, unknown>;
        const id = typeof ws.ref === "string" ? ws.ref : typeof ws.id === "string" ? ws.id : "";
        if (!id) continue;
        const message =
          (typeof ws.latest_conversation_message === "string" && ws.latest_conversation_message) ||
          (typeof ws.latest_submitted_message === "string" && ws.latest_submitted_message) ||
          "";
        const color =
          typeof ws.custom_color === "string" && /^#[0-9a-f]{6}$/i.test(ws.custom_color)
            ? ws.custom_color
            : undefined;
        const rawTitle = typeof ws.title === "string" ? ws.title : "";
        out.set(id, { title: resolveTitle(ws), message, color, activity: detectActivity(rawTitle) });
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === "object") visit(v);
    }
  };
  visit(raw);
  return out;
}
