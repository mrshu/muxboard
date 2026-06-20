import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Load and parse a JSON fixture from test/fixtures. */
export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as T;
}

/** A fixed clock for deterministic age/countdown assertions. */
export const NOW_MS = Date.parse("2026-06-20T12:10:00Z");
