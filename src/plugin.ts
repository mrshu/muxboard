import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { DEFAULT_CONFIG, resolveConfig, type MuxboardConfig } from "./config.js";
import { CmuxClient } from "./core/cmux/client.js";
import { CodexbarClient } from "./core/codexbar/client.js";
import { Store } from "./core/services/store.js";
import { CmuxService } from "./core/services/cmuxService.js";
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

async function loadConfig(): Promise<MuxboardConfig> {
  try {
    const settings = await streamDeck.settings.getGlobalSettings<Partial<MuxboardConfig>>();
    return resolveConfig(settings);
  } catch (err) {
    logger.warn(`falling back to default config: ${err instanceof Error ? err.message : err}`);
    return DEFAULT_CONFIG;
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();
  logger.info(
    `Muxboard starting: cmux="${config.cmuxBin}" codexbar="${config.codexbarBaseUrl}" providers=${config.codexbarProviders.join(",")}`,
  );

  const store = new Store(config.codexbarProviders);
  const cmux = new CmuxClient({ bin: config.cmuxBin });
  const codexbar = new CodexbarClient({ baseUrl: config.codexbarBaseUrl });

  const cmuxService = new CmuxService({ client: cmux, store, pollMs: config.cmuxPollMs, logger });
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

  cmuxService.start();
  codexbarService.start();
  logger.info("Muxboard connected; polling started.");
}

void main();
