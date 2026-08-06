import type { CmuxClient } from "../cmux/client.js";
import type { AttentionItem } from "../types.js";
import { AttentionPoller, type AttentionPollerOptions } from "./attentionPoller.js";

export interface CmuxServiceOptions extends AttentionPollerOptions {
  client: CmuxClient;
}

/** Polls cmux for the attention queue and pushes it into the store. */
export class CmuxService extends AttentionPoller {
  private readonly client: CmuxClient;

  constructor(opts: CmuxServiceOptions) {
    super("cmux", opts);
    this.client = opts.client;
  }

  /**
   * Pass the live event-stream status so the client can synthesize
   * notification-less "running" panes that have no title spinner.
   */
  protected fetch(): Promise<AttentionItem[]> {
    return this.client.listAttention(this.store.getState().workspaceStatus);
  }
}
