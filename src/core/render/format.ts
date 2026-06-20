/**
 * Small, pure formatting helpers for compact key/LCD labels.
 *
 * All functions take an explicit "now" (epoch ms) so they are deterministic and
 * unit-testable; callers pass Date.now() at render time.
 */

/** Compact age like "now", "45s", "2m", "3h", "5d". */
export function formatAge(createdAtIso: string, nowMs: number): string {
  const then = Date.parse(createdAtIso);
  if (Number.isNaN(then)) return "?";
  return formatAgeFromSeconds(Math.floor((nowMs - then) / 1000));
}

/** Format an age given directly in seconds (shared by age-from-ms callers). */
export function formatAgeFromSeconds(seconds: number): string {
  const sec = Math.max(0, Math.floor(seconds));
  if (sec < 5) return "now";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

/** Compact countdown to a reset like "2h", "45m", "now", or "—" if unknown. */
export function formatCountdown(resetsAtIso: string | undefined, nowMs: number): string {
  if (!resetsAtIso) return "—";
  const target = Date.parse(resetsAtIso);
  if (Number.isNaN(target)) return "—";
  const sec = Math.floor((target - nowMs) / 1000);
  if (sec <= 0) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}d${remHr}h` : `${day}d`;
}

/** Round a 0..100 percentage to a whole number string with %. */
export function formatPercent(percent: number): string {
  return `${Math.round(Math.max(0, Math.min(100, percent)))}%`;
}

/** Money like "€4.20"; integers drop the cents ("€0"). */
export function formatEur(amount: number | undefined): string {
  if (amount === undefined || Number.isNaN(amount)) return "—";
  if (amount === 0) return "€0";
  return `€${amount.toFixed(2)}`;
}

/**
 * Shorten a repo/workspace label to fit a key.
 *
 * Strips a leading path, keeps the last segment, and truncates with an ellipsis.
 */
export function shortName(name: string | undefined, max = 12): string {
  if (!name) return "";
  let s = name.trim();
  // Keep the last path-ish segment if it looks like a path.
  if (s.includes("/")) {
    const parts = s.split("/").filter(Boolean);
    s = parts[parts.length - 1] ?? s;
  }
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Collapse markdown/whitespace in an agent message to clean inline text. */
export function cleanMessage(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ") // drop fenced code blocks
    .replace(/[`*_#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Wrap text into up to `maxLines` lines of ~`maxChars`, breaking on spaces.
 * The last line is ellipsized if text remains. Used for the key message band.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = cleanMessage(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length <= maxChars) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = w.length > maxChars ? `${w.slice(0, maxChars - 1)}…` : w;
      if (lines.length === maxLines) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines) {
    // If content remains beyond the last line, mark it truncated.
    const consumed = lines.join(" ").length;
    if (consumed < cleanMessage(text).length && !lines[maxLines - 1].endsWith("…")) {
      lines[maxLines - 1] = `${lines[maxLines - 1].replace(/.$/, "")}…`;
    }
  }
  return lines;
}

/** Rough SVG text width (no DOM): ~0.6em/char for a bold sans title. */
function estTextWidth(s: string, fontSize: number): number {
  return s.trim().length * fontSize * 0.6;
}

const LINE_H = 1.14;

/** Break a string into atoms that may wrap AFTER a space/hyphen/underscore/slash. */
function atomize(text: string): string[] {
  return cleanMessage(text)
    .split(/(?<=[ \-_/])/)
    .filter((s) => s.length > 0);
}

/** Greedy-pack atoms into lines at a font size; `fits` is false if an atom is too wide. */
function wrapAtoms(atoms: string[], boxW: number, fs: number): { lines: string[]; fits: boolean } {
  const lines: string[] = [];
  let line = "";
  for (const atom of atoms) {
    if (estTextWidth(atom, fs) > boxW) return { lines: [], fits: false }; // needs hard-break
    if (estTextWidth(line + atom, fs) <= boxW) {
      line += atom;
    } else {
      if (line) lines.push(line.trim());
      line = atom;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return { lines, fits: true };
}

/** Hard-break by characters (last resort) and ellipsize beyond maxLines. */
function hardWrap(text: string, boxW: number, fs: number, maxLines: number): string[] {
  const s = cleanMessage(text);
  const perLine = Math.max(1, Math.floor(boxW / (fs * 0.6)));
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += perLine) lines.push(s.slice(i, i + perLine));
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, perLine - 1)}…`;
    return kept;
  }
  return lines;
}

/**
 * Fit `text` into a `boxW`×`boxH` box: shrink the font (maxFs→minFs) until the
 * title wraps — at word/hyphen/slash boundaries, never mid-character — within
 * the available height. Hard-breaks + ellipsizes only at the floor. Returns the
 * chosen font size and lines, for showing a full title on a small tile.
 */
export function fitText(
  text: string,
  boxW: number,
  boxH: number,
  minFs = 15,
  maxFs = 30,
): { fontSize: number; lines: string[] } {
  const atoms = atomize(text);
  for (let fs = maxFs; fs >= minFs; fs--) {
    const { lines, fits } = wrapAtoms(atoms, boxW, fs);
    if (fits && lines.length * fs * LINE_H <= boxH) return { fontSize: fs, lines };
  }
  const maxLines = Math.max(1, Math.floor(boxH / (minFs * LINE_H)));
  return { fontSize: minFs, lines: hardWrap(text, boxW, minFs, maxLines) };
}

/** XML-escape text for safe SVG embedding. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
