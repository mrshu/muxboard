import type { OrcaClient } from "../orca/client.js";
import type { AttentionItem } from "../types.js";
import { AttentionPoller, type AttentionPollerOptions } from "./attentionPoller.js";

export interface OrcaServiceOptions extends AttentionPollerOptions {
  client: OrcaClient;
}

/** Polls Orca for the attention queue and pushes it into the store's orca slice. */
export class OrcaService extends AttentionPoller {
  private readonly client: OrcaClient;

  constructor(opts: OrcaServiceOptions) {
    super("orca", opts);
    this.client = opts.client;
  }

  protected fetch(): Promise<AttentionItem[]> {
    return this.client.listAttention();
  }
}
