/** Per-workspace context resolved from `cmux workspace list`. */
export interface WorkspaceInfo {
  /** Best human title: custom_title → cleaned title → basename(cwd). */
  title: string;
  /** The pane's latest conversation message (optional fallback content). */
  message: string;
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
        out.set(id, { title: resolveTitle(ws), message });
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
