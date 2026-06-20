#!/usr/bin/env node
/**
 * Install the Muxboard profile by writing it DIRECTLY into the Stream Deck app's
 * profile store (ProfilesV3), bypassing the app's profile importer.
 *
 * Why: the app's plugin/file profile importer rejects hand-authored
 * `.streamDeckProfile` archives ("content corrupted") on this build. But the app
 * also just folder-scans ProfilesV3 on launch, so writing a profile there in the
 * app's own V3 format makes it appear in the profile dropdown — no import, no
 * dragging. The user then selects "Muxboard" for their Stream Deck+.
 *
 * The Stream Deck app MUST be closed while this runs (the caller handles that).
 *
 *   node scripts/install-profile.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE = join(homedir(), "Library/Application Support/com.elgato.StreamDeck/ProfilesV3");
const ATTENTION_UUID = "com.mrshu.muxboard.attention";
const DIAL_UUID = "com.mrshu.muxboard.dial";
const PLUGIN = { Name: "Muxboard", UUID: "com.mrshu.muxboard", Version: "0.1.0.0" };

if (!existsSync(STORE)) {
  console.error(`Stream Deck profile store not found: ${STORE}`);
  process.exit(1);
}

/** Find an existing profile for a Stream Deck+ (model 20GBD9901) to copy the Device block. */
function findDevice() {
  for (const entry of readdirSync(STORE)) {
    if (!entry.endsWith(".sdProfile")) continue;
    try {
      const m = JSON.parse(readFileSync(join(STORE, entry, "manifest.json"), "utf8"));
      if (m.Device && m.Device.Model === "20GBD9901") return m.Device;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const device = findDevice();
if (!device || !device.UUID) {
  console.error("No Stream Deck+ (20GBD9901) profile found to read the device UUID from.");
  console.error("Open the Stream Deck app with the device connected once, then retry.");
  process.exit(1);
}

// Idempotent: remove any previously-installed Muxboard profile first.
for (const entry of readdirSync(STORE)) {
  if (!entry.endsWith(".sdProfile")) continue;
  try {
    const m = JSON.parse(readFileSync(join(STORE, entry, "manifest.json"), "utf8"));
    if (m.Name === "Muxboard") rmSync(join(STORE, entry), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function keyAction(slot) {
  return {
    ActionID: randomUUID(),
    LinkedTitle: false,
    Name: "Attention Slot",
    Plugin: PLUGIN,
    Resources: null,
    Settings: {},
    State: 0,
    States: [{ ShowTitle: false }],
    UUID: ATTENTION_UUID,
  };
}
function dialAction() {
  return {
    ActionID: randomUUID(),
    Encoder: {},
    LinkedTitle: false,
    Name: "Muxboard Dial",
    Plugin: PLUGIN,
    Resources: null,
    Settings: {},
    State: 0,
    States: [{}],
    UUID: DIAL_UUID,
  };
}

const dials = {};
for (let col = 0; col < 4; col++) dials[`${col},0`] = dialAction();
const keys = {};
for (let row = 0; row < 2; row++) {
  for (let col = 0; col < 4; col++) keys[`${col},${row}`] = keyAction(row * 4 + col);
}

// Match the live-store layout: Encoder controller first, then Keypad.
const page = {
  Name: "",
  Controllers: [
    { Type: "Encoder", Actions: dials },
    { Type: "Keypad", Actions: keys },
  ],
};

const profileId = randomUUID().toUpperCase();
const pageId = randomUUID().toUpperCase();
const root = join(STORE, `${profileId}.sdProfile`);
const pageDir = join(root, "Profiles", pageId);
mkdirSync(join(root, "Images"), { recursive: true });
mkdirSync(join(pageDir, "Images"), { recursive: true });

writeFileSync(
  join(root, "manifest.json"),
  JSON.stringify({
    Device: device,
    Name: "Muxboard",
    Pages: { Current: pageId, Pages: [pageId] },
    Version: "3.0",
  }),
);
writeFileSync(join(pageDir, "manifest.json"), JSON.stringify(page));

console.log(`Installed Muxboard profile → ${root}`);
console.log(`  device: ${device.Model} ${device.UUID}`);
console.log("  Launch Stream Deck and pick 'Muxboard' from the profile dropdown.");
