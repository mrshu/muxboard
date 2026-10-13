import { brotliDecompressSync } from "node:zlib";
import { NERD_GLYPHS_BR } from "./nerdGlyphs.js";

let glyphs: Record<string, [advance: number, path: string]> | undefined;

/**
 * Outline of a Nerd Font icon character at font size 24 (baseline at y = 0),
 * or undefined for a character the Symbols Nerd Font does not define. Decoded
 * on first use: most boards never contain an icon.
 */
export function nerdIcon(ch: string): { advance: number; path: string } | undefined {
  glyphs ??= JSON.parse(brotliDecompressSync(Buffer.from(NERD_GLYPHS_BR, "base64")).toString("utf8")) as Record<string, [number, string]>;
  const glyph = glyphs[(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()];
  return glyph && { advance: glyph[0], path: glyph[1] };
}
