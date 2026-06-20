/**
 * Generates the PNG icon set the manifest references, from inline SVG, via
 * @resvg/resvg-js. Run once (and after changing the mark):
 *
 *   npm run icons
 *
 * Output goes into the .sdPlugin/imgs tree at the @1x/@2x sizes Stream Deck
 * expects. The Muxboard mark is a 4×2 grid of keys with one "alert" key lit —
 * evoking the attention board.
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const imgs = join(here, "..", "com.mrshu.muxboard.sdPlugin", "imgs");

/** The board mark: 4×2 rounded keys, top-left lit orange. */
function boardMark(size: number, bg = "#0c0d10"): string {
  const pad = size * 0.12;
  const gap = size * 0.06;
  const cols = 4;
  const rows = 2;
  const cw = (size - pad * 2 - gap * (cols - 1)) / cols;
  const ch = (size - pad * 2 - gap * (rows - 1)) / rows;
  let cells = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = pad + c * (cw + gap);
      const y = pad + r * (ch + gap);
      const lit = r === 0 && c === 0;
      const fill = lit ? "#d97746" : "#2a2d34";
      cells += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" rx="${(cw * 0.18).toFixed(1)}" fill="${fill}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size * 0.16}" fill="${bg}"/>${cells}</svg>`;
}

/** A neutral key-state tile (shown before the plugin paints a slot). */
function keyTile(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size * 0.12}" fill="#0d0e10"/><rect x="3" y="3" width="${size - 6}" height="${size - 6}" rx="${size * 0.1}" fill="none" stroke="#1c1e22" stroke-width="2"/></svg>`;
}

/** Encoder background segment (200×100). */
function segmentBg(w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#0b0c0e"/></svg>`;
}

function writePng(relPath: string, svg: string, width: number): void {
  const full = join(imgs, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  writeFileSync(full, png);
}

/** Emit @1x and @2x for a square asset. */
function square(rel: string, base: number, svg: (s: number) => string): void {
  writePng(`${rel}.png`, svg(base), base);
  writePng(`${rel}@2x.png`, svg(base * 2), base * 2);
}

function main(): void {
  // Plugin + category icons (28px).
  square("plugin/icon", 28, boardMark);
  square("plugin/category", 28, boardMark);
  // Action icons (20px) + key-state image (72px).
  square("actions/attention/icon", 20, boardMark);
  square("actions/attention/key", 72, keyTile);
  square("actions/dial/icon", 20, boardMark);
  square("actions/dial/key", 72, keyTile);
  // Encoder background segment (200×100 @1x, 400×200 @2x).
  writePng("actions/dial/segment.png", segmentBg(200, 100), 200);
  writePng("actions/dial/segment@2x.png", segmentBg(400, 200), 400);

  console.log(`Generated icon set under ${imgs}`);
}

main();
