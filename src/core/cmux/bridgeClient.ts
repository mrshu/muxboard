import type { AttentionItem } from "../types.js";
import { normalizeNotifications } from "./normalize.js";
import type { CmuxSource } from "./source.js";

/** Minimal fetch surface so the client is testable without a real server. */
export type HttpClient = (
  url: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CmuxBridgeClientOptions {
  /** Base URL of the Muxboard bridge. Defaults to http://127.0.0.1:17779. */
  baseUrl?: string;
  /** Injected fetch for tests; defaults to global fetch. */
  http?: HttpClient;
}

/**
 * Reads cmux state from the Muxboard bridge over HTTP.
 *
 * The bridge (running inside the user's cmux session) executes the cmux CLI on
 * the plugin's behalf and returns the raw notification JSON, which this client
 * normalizes. This is how the Stream Deck plugin — launched outside any cmux
 * session, where the cmux socket rejects it — reaches cmux.
 */
export class CmuxBridgeClient implements CmuxSource {
  private readonly baseUrl: string;
  private readonly http: HttpClient;

  constructor(opts: CmuxBridgeClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:17779").replace(/\/+$/, "");
    this.http = opts.http ?? ((url, init) => fetch(url, init));
  }

  private async request(path: string, method = "GET"): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await this.http(`${this.baseUrl}${path}`, { method, signal: controller.signal });
      if (!res.ok) throw new Error(`bridge HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /notifications → raw cmux JSON → normalized AttentionItems. */
  async listAttention(): Promise<AttentionItem[]> {
    const raw = await this.request("/notifications");
    return normalizeNotifications(raw);
  }

  /** POST /open?id=… → cmux open-notification. */
  async openNotification(id: string): Promise<void> {
    await this.request(`/open?id=${encodeURIComponent(id)}`, "POST");
  }

  /** POST /select-workspace?id=… → cmux select-workspace. */
  async selectWorkspace(workspaceId: string): Promise<void> {
    await this.request(`/select-workspace?id=${encodeURIComponent(workspaceId)}`, "POST");
  }

  /** True when the bridge `/health` responds ok. */
  async health(): Promise<boolean> {
    try {
      const body = (await this.request("/health")) as { status?: string };
      return body?.status === "ok";
    } catch {
      return false;
    }
  }
}
