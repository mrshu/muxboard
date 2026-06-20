import type { AttentionItem } from "../types.js";

/**
 * Abstraction over "where cmux state comes from".
 *
 * Two implementations:
 *  - {@link CmuxClient} spawns the cmux CLI directly (works inside a cmux
 *    session — used by the bridge).
 *  - {@link CmuxBridgeClient} fetches from the localhost bridge over HTTP (used
 *    by the Stream Deck plugin, which runs outside any cmux session).
 *
 * The polling service and key action depend only on this interface.
 */
export interface CmuxSource {
  /** Current attention queue, normalized. */
  listAttention(): Promise<AttentionItem[]>;
  /** Focus the workspace + surface behind a notification. */
  openNotification(id: string): Promise<void>;
  /** Fallback: select a workspace by id. */
  selectWorkspace(workspaceId: string): Promise<void>;
}
