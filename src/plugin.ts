import streamDeck, { DeviceType, LogLevel } from "@elgato/streamdeck";
import { DEFAULT_CONFIG, resolveConfig, type MuxboardConfig } from "./config.js";
import { CmuxBridgeClient } from "./core/cmux/bridgeClient.js";
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
  // The plugin runs outside any cmux session, so it reads cmux via the bridge.
  const cmux = new CmuxBridgeClient({ baseUrl: config.cmuxBridgeUrl });
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
  logger.info("Muxboard connected.");

  // Now the websocket exists: settings round-trips are safe.
  Object.assign(config, await resolveConfigAfterConnect());
  logger.info(
    `Muxboard config: bridge="${config.cmuxBridgeUrl}" codexbar="${config.codexbarBaseUrl}" providers=${config.codexbarProviders.join(",")}`,
  );

  cmuxService.start();
  codexbarService.start();
  logger.info("Polling started.");

  applyProfileToStreamDeckPlus();
}

/** Name of the predefined profile, matching manifest Profiles[].Name. */
const MUXBOARD_PROFILE = "profiles/muxboard";

/**
 * Switch every Stream Deck+ to the bundled Muxboard profile so all 8 keys and 4
 * dials are populated without the user placing anything. Switches once per
 * device per process (re-applying on every reconnect would fight the user if
 * they navigate away). Best-effort: failures are logged, not fatal.
 */
function applyProfileToStreamDeckPlus(): void {
  const switched = new Set<string>();
  const apply = (deviceId: string, deviceType: DeviceType): void => {
    if (deviceType !== DeviceType.StreamDeckPlus) return;
    if (switched.has(deviceId)) return;
    switched.add(deviceId);
    streamDeck.profiles
      .switchToProfile(deviceId, MUXBOARD_PROFILE)
      .then(() => logger.info(`Applied Muxboard profile to device ${deviceId}`))
      .catch((err) => logger.warn(`switchToProfile failed: ${err instanceof Error ? err.message : err}`));
  };

  for (const device of streamDeck.devices) {
    if (device.isConnected) apply(device.id, device.type);
  }
  streamDeck.devices.onDeviceDidConnect((ev) => apply(ev.device.id, ev.device.type));
}

void main();
