import { execFile } from "node:child_process";
import type { MuxboardConfig } from "./config.js";
import type { Logger } from "./core/services/logger.js";
import type { Store } from "./core/services/store.js";
import type { CmuxClient } from "./core/cmux/client.js";
import type { CmuxService } from "./core/services/cmuxService.js";
import type { CmuxEventsService } from "./core/services/cmuxEventsService.js";
import type { CodexbarService } from "./core/services/codexbarService.js";
import type { AttentionItem, AttentionSource } from "./core/types.js";
import type { OrcaClient } from "./core/orca/client.js";
import type { OrcaService } from "./core/services/orcaService.js";

/**
 * Shared runtime handed to the Stream Deck actions: the store they render from,
 * the clients/services they drive, and config. Constructed once in plugin.ts.
 */
export interface Runtime {
  config: MuxboardConfig;
  store: Store;
  cmux: CmuxClient;
  cmuxService: CmuxService;
  cmuxEventsService: CmuxEventsService;
  codexbarService: CodexbarService;
  /** Orca poller; force-refresh triggers it when Orca is active. */
  orcaService: OrcaService;
  logger: Logger;
  /** Records the local "last opened" time for an attention item. */
  markOpened(id: string): void;
  /** Most recent local open time per item id (not persisted across restarts). */
  lastOpened: Map<string, number>;
  /** Per-source focus/dismiss backends, resolved by item.source. */
  backends: Record<AttentionSource, AttentionBackend>;
}

/** Per-source focus/dismiss capability resolved by item.source. */
export interface AttentionBackend {
  /** Bring the source app forward and jump to the item's surface. */
  focus(item: AttentionItem): Promise<void>;
  /** Long-press action. cmux removes the notification; Orca re-focuses. */
  dismiss(item: AttentionItem): Promise<void>;
}

/** Bring an app to the foreground on macOS (best-effort). */
function bringAppToFront(app: string, logger: Logger): void {
  execFile("open", ["-a", app], (err) => {
    if (err) logger.warn(`bring ${app} to front failed: ${err.message}`);
  });
}

export function makeCmuxBackend(
  cmux: CmuxClient,
  logger: Logger,
  markOpened: (id: string) => void,
): AttentionBackend {
  return {
    async focus(item) {
      bringAppToFront("cmux", logger);
      if (item.synthetic) {
        await cmux.selectWorkspace(item.workspaceId);
        return;
      }
      try {
        await cmux.openNotification(item.id);
      } catch (err) {
        logger.warn(`open-notification failed, falling back: ${err instanceof Error ? err.message : err}`);
        await cmux.selectWorkspace(item.workspaceId);
      }
      markOpened(item.id);
    },
    async dismiss(item) {
      await cmux.dismissNotification(item.id);
    },
  };
}

export function makeOrcaBackend(orca: OrcaClient, logger: Logger): AttentionBackend {
  return {
    async focus(item) {
      bringAppToFront("Orca", logger);
      await orca.focus(item);
    },
    // No dismiss primitive in Orca; focusing the worktree clears its unread.
    async dismiss(item) {
      bringAppToFront("Orca", logger);
      await orca.focus(item);
    },
  };
}
