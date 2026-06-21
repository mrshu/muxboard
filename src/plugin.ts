import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { DEFAULT_CONFIG, resolveConfig, type MuxboardConfig } from "./config.js";
import { CmuxClient } from "./core/cmux/client.js";
import { CodexbarClient } from "./core/codexbar/client.js";
import { Store } from "./core/services/store.js";
import { CmuxService } from "./core/services/cmuxService.js";
import { CmuxEventsService } from "./core/services/cmuxEventsService.js";
import { CodexbarService } from "./core/services/codexbarService.js";
import type { Logger } from "./core/services/logger.js";
import type { Runtime } from "./runtime.js";
import { AttentionKeyAction } from "./actions/attentionKey.js";
import { DialStripAction } from "./actions/dialStrip.js";

streamDeck.logger.setLevel(LogLevel.INFO);

/** Adapt the Stream Deck logger to the core Logger interface. */
const logger: Logger = {
  info: (m) => streamDeck.logger.info(m),
  warn: (m) => streamDeck.logger.warn(m),
  error: (m) => streamDeck.logger.error(m),
};

/**
 * Resolve config from global settings. MUST be called only after connect(),
 * since it performs a websocket round-trip. Falls back to defaults on any error
 * (including empty/never-set settings).
 */
async function resolveConfigAfterConnect(): Promise<MuxboardConfig> {
  try {
    const settings = await streamDeck.settings.getGlobalSettings<Partial<MuxboardConfig>>();
    return resolveConfig(settings);
  } catch (err) {
    logger.warn(`falling back to default config: ${err instanceof Error ? err.message : err}`);
    return DEFAULT_CONFIG;
  }
}

async function main(): Promise<void> {
  // Build the runtime with defaults synchronously so actions can register
  // BEFORE connect (avoids missing the initial willAppear). Critically, no
  // awaited websocket calls happen before connect() — doing so would leave the
  // event loop with no open handles and exit the process cleanly.
  const config: MuxboardConfig = { ...DEFAULT_CONFIG };
  const store = new Store(config.codexbarProviders);
  // Talk to cmux directly. This requires cmux's automation mode
  // (socketControlMode: "automation") so the plugin's process is accepted.
  const cmux = new CmuxClient({
    bin: config.cmuxBin,
    agentAliases: config.agentAliases,
    busyCpuPercent: config.busyCpuPercent,
  });
  const codexbar = new CodexbarClient({ baseUrl: config.codexbarBaseUrl });
  const cmuxService = new CmuxService({ client: cmux, store, pollMs: config.cmuxPollMs, logger });
  const cmuxEventsService = new CmuxEventsService({ bin: config.cmuxBin, store, logger });
  const codexbarService = new CodexbarService({
    client: codexbar,
    store,
    providers: config.codexbarProviders,
    pollMs: config.codexbarPollMs,
    logger,
  });

  const runtime: Runtime = {
    config,
    store,
    cmux,
    cmuxService,
    cmuxEventsService,
    codexbarService,
    logger,
    lastOpened: new Map<string, number>(),
    markOpened(id: string) {
      this.lastOpened.set(id, Date.now());
    },
  };

  streamDeck.actions.registerAction(new AttentionKeyAction(runtime));
  streamDeck.actions.registerAction(new DialStripAction(runtime));

  await streamDeck.connect();
  logger.info("Muxboard connected.");

  // Now the websocket exists: settings round-trips are safe.
  Object.assign(config, await resolveConfigAfterConnect());
  logger.info(
    `Muxboard config: cmux="${config.cmuxBin}" codexbar="${config.codexbarBaseUrl}" providers=${config.codexbarProviders.join(",")}`,
  );

  cmuxService.start();
  cmuxEventsService.start();
  codexbarService.start();
  logger.info("Polling started.");

  // Stop services on shutdown so the long-lived `cmux events` child is killed
  // rather than orphaned (Node doesn't reap child processes on exit).
  const shutdown = (): void => {
    cmuxEventsService.stop();
    cmuxService.stop();
    codexbarService.stop();
  };
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
}

void main();
