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
import { makeCmuxBackend, makeOrcaBackend } from "./runtime.js";
import { OrcaClient } from "./core/orca/client.js";
import { OrcaService } from "./core/services/orcaService.js";
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

/**
 * Build the config-derived clients, services, and focus/dismiss backends around
 * a (stable) store. Pure construction — no I/O and no timers until a service is
 * .start()ed — so it is cheap to build once with defaults and rebuild once the
 * real global settings arrive after connect.
 */
function buildServices(config: MuxboardConfig, store: Store, logger: Logger) {
  // Talk to cmux directly. This requires cmux's automation mode
  // (socketControlMode: "automation") so the plugin's process is accepted.
  const cmux = new CmuxClient({
    bin: config.cmuxBin,
    agentAliases: config.agentAliases,
    busyCpuPercent: config.busyCpuPercent,
  });
  const codexbar = new CodexbarClient({ baseUrl: config.codexbarBaseUrl });
  const orca = new OrcaClient({ bin: config.orcaBin });
  return {
    cmux,
    orca,
    orcaService: new OrcaService({ client: orca, store, pollMs: config.orcaPollMs, logger }),
    cmuxService: new CmuxService({ client: cmux, store, pollMs: config.cmuxPollMs, logger }),
    cmuxEventsService: new CmuxEventsService({ bin: config.cmuxBin, store, logger }),
    codexbarService: new CodexbarService({
      client: codexbar,
      store,
      providers: config.codexbarProviders,
      pollMs: config.codexbarPollMs,
      logger,
    }),
    backends: {
      cmux: makeCmuxBackend(cmux, logger),
      orca: makeOrcaBackend(orca, logger),
    },
  };
}

async function main(): Promise<void> {
  // Build the runtime synchronously so actions can register BEFORE connect
  // (avoids missing the initial willAppear). Critically, no awaited websocket
  // calls happen before connect() — doing so would leave the event loop with no
  // open handles and exit the process cleanly. The store is built once here and
  // never replaced: the actions subscribe to it in their constructors, so its
  // identity must stay stable across the post-connect config reload.
  const config: MuxboardConfig = { ...DEFAULT_CONFIG };
  const store = new Store(config.codexbarProviders);

  // Placeholder services from defaults, so the runtime is fully valid for any
  // willAppear that lands in the brief window before global settings load. They
  // hold no resources (nothing polls until .start()) and are replaced below once
  // the real config is known.
  let services = buildServices(config, store, logger);

  const runtime: Runtime = {
    config,
    store,
    cmux: services.cmux,
    cmuxService: services.cmuxService,
    cmuxEventsService: services.cmuxEventsService,
    codexbarService: services.codexbarService,
    orcaService: services.orcaService,
    logger,
    backends: services.backends,
  };

  streamDeck.actions.registerAction(new AttentionKeyAction(runtime));
  streamDeck.actions.registerAction(new DialStripAction(runtime));

  await streamDeck.connect();
  logger.info("Muxboard connected.");

  // Now the websocket exists: settings round-trips are safe. Apply the resolved
  // config and rebuild the config-derived clients/services, then swap them into
  // the runtime — otherwise tunables like cmuxBin, the poll intervals,
  // busyCpuPercent, and the codexbar URL/providers would never take effect,
  // having been captured by value into the default-built placeholders above.
  Object.assign(config, await resolveConfigAfterConnect());
  services = buildServices(config, store, logger);
  runtime.cmux = services.cmux;
  runtime.cmuxService = services.cmuxService;
  runtime.cmuxEventsService = services.cmuxEventsService;
  runtime.codexbarService = services.codexbarService;
  runtime.orcaService = services.orcaService;
  runtime.backends = services.backends;
  logger.info(
    `Muxboard config: cmux="${config.cmuxBin}" codexbar="${config.codexbarBaseUrl}" providers=${config.codexbarProviders.join(",")}`,
  );

  const { cmuxService, cmuxEventsService, codexbarService, orcaService, orca } = services;
  cmuxService.start();
  cmuxEventsService.start();
  codexbarService.start();
  logger.info("Polling started.");

  // Start the Orca poller per config: forced on, or auto when a runtime is
  // reachable. In auto mode, if Orca isn't up yet, re-probe on a slow cadence so
  // opening Orca later brings the board to life without a plugin restart.
  let orcaStarted = false;
  let orcaProbe: ReturnType<typeof setInterval> | null = null;
  const startOrca = (): void => {
    if (orcaStarted) return;
    orcaStarted = true;
    store.setOrcaActive(true);
    orcaService.start();
    logger.info("Orca poller started.");
  };
  const tryStartOrca = async (): Promise<void> => {
    if (orcaStarted) return;
    if (config.enableOrca === false) return;
    if (config.enableOrca === true || (await orca.reachable())) {
      startOrca();
      if (orcaProbe) { clearInterval(orcaProbe); orcaProbe = null; }
    }
  };
  void tryStartOrca();
  if (config.enableOrca === "auto") {
    orcaProbe = setInterval(() => void tryStartOrca(), 30_000);
  }

  // Stop services on shutdown so the long-lived `cmux events` child is killed
  // rather than orphaned (Node doesn't reap child processes on exit).
  const shutdown = (): void => {
    cmuxEventsService.stop();
    cmuxService.stop();
    codexbarService.stop();
    orcaService.stop();
    if (orcaProbe) clearInterval(orcaProbe);
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
