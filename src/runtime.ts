import { execFile } from "node:child_process";
import type { MuxboardConfig } from "./config.js";
import type { Logger } from "./core/services/logger.js";
import type { Store } from "./core/services/store.js";
import type { CmuxClient } from "./core/cmux/client.js";
import type { CmuxService } from "./core/services/cmuxService.js";
import type { CodexbarService } from "./core/services/codexbarService.js";

/**
 * Shared runtime handed to the Stream Deck actions: the store they render from,
 * the clients/services they drive, and config. Constructed once in plugin.ts.
 */
export interface Runtime {
  config: MuxboardConfig;
  store: Store;
  cmux: CmuxClient;
  cmuxService: CmuxService;
  codexbarService: CodexbarService;
  logger: Logger;
  /** Records the local "last opened" time for an attention item. */
  markOpened(id: string): void;
  /** Most recent local open time per item id (not persisted across restarts). */
  lastOpened: Map<string, number>;
}

/**
 * Bring cmux to the foreground on macOS.
 *
 * Best-effort: uses `open -a cmux`, which activates the app without altering
 * any cmux state. Failures are swallowed so a focus attempt never throws into
 * the key handler.
 */
export function bringCmuxToFront(logger: Logger): void {
  execFile("open", ["-a", "cmux"], (err) => {
    if (err) logger.warn(`bringCmuxToFront failed: ${err.message}`);
  });
}
