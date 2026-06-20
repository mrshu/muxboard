/**
 * Parse `cmux --id-format uuids workspace list --json` into a
 * workspaceId → latest-message map.
 *
 * The output is `{ window_ref, workspaces: [...] }` per window; each workspace
 * carries `ref` (the UUID under --id-format uuids) and the pane's most recent
 * conversation text. That message is the most differentiating thing to show on
 * a key — what the pane is actually about — far better than a generic status.
 */
export function parseWorkspaceMessages(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.workspaces)) {
      for (const w of n.workspaces) {
        if (!w || typeof w !== "object") continue;
        const ws = w as Record<string, unknown>;
        const id = typeof ws.ref === "string" ? ws.ref : typeof ws.id === "string" ? ws.id : "";
        if (!id) continue;
        const msg =
          (typeof ws.latest_conversation_message === "string" && ws.latest_conversation_message) ||
          (typeof ws.latest_submitted_message === "string" && ws.latest_submitted_message) ||
          "";
        if (msg) out.set(id, msg);
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
