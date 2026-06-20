/**
 * Generates a predefined Stream Deck+ profile that pre-places the Muxboard
 * actions on all 8 keys and all 4 dials, so the user never has to drag anything.
 *
 *   npm run profile
 *
 * Output: com.mrshu.muxboard.sdPlugin/profiles/muxboard.streamDeckProfile
 * (a zip of a `<uuid>.sdProfile` bundle, the format the Stream Deck app imports).
 *
 * The manifest declares this profile (Profiles[].Name = "profiles/muxboard",
 * DeviceType 7); the plugin switches to it on connect. Format reverse-engineered
 * from the app's own StreamDeckPlus_macDefault.streamDeckProfile:
 *   - Device.Model 20GBD9901 = Stream Deck+
 *   - Controllers[0] Type "Encoder" → 4 dials at "0,0".."3,0"
 *   - Controllers[1] Type "Keypad"  → 8 keys at "0,0".."3,1"
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", "com.mrshu.muxboard.sdPlugin");
const ATTENTION_UUID = "com.mrshu.muxboard.attention";
const DIAL_UUID = "com.mrshu.muxboard.dial";

/** A keypad action placed on one key. */
function keyAction(): object {
  return {
    ActionID: randomUUID(),
    Name: "Attention Slot",
    LinkedTitle: false,
    Settings: {},
    State: 0,
    States: [{ ShowTitle: false }],
    UUID: ATTENTION_UUID,
  };
}

/** An encoder action placed on one dial. */
function dialAction(): object {
  return {
    ActionID: randomUUID(),
    Encoder: {},
    Name: "Muxboard Dial",
    LinkedTitle: false,
    Settings: {},
    State: 0,
    States: [{}],
    UUID: DIAL_UUID,
  };
}

function buildPageManifest(): object {
  const dials: Record<string, object> = {};
  for (let col = 0; col < 4; col++) dials[`${col},0`] = dialAction();

  const keys: Record<string, object> = {};
  // Physical 1 2 3 4 / 5 6 7 8 → coordinates (col,row).
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) keys[`${col},${row}`] = keyAction();
  }

  return {
    Name: "Muxboard",
    Controllers: [
      { Type: "Encoder", Actions: dials },
      { Type: "Keypad", Actions: keys },
    ],
  };
}

function main(): void {
  const pageId = randomUUID().toUpperCase();
  const profileId = randomUUID().toUpperCase();

  const tmp = mkdtempSync(join(tmpdir(), "muxprofile-"));
  const sdProfile = join(tmp, `${profileId}.sdProfile`);
  const pageDir = join(sdProfile, "Profiles", pageId);
  mkdirSync(join(sdProfile, "Images"), { recursive: true });
  mkdirSync(join(pageDir, "Images"), { recursive: true });

  // Outer manifest: a single page for the Stream Deck+ (model 20GBD9901).
  writeFileSync(
    join(sdProfile, "manifest.json"),
    JSON.stringify({
      Device: { Model: "20GBD9901", UUID: "" },
      Name: "Muxboard",
      Pages: { Current: pageId, Pages: [pageId] },
      Version: "2.0",
    }),
  );
  writeFileSync(join(pageDir, "manifest.json"), JSON.stringify(buildPageManifest(), null, 1));

  // Zip the .sdProfile bundle into profiles/muxboard.streamDeckProfile.
  const outDir = join(pluginDir, "profiles");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, "muxboard.streamDeckProfile");
  rmSync(out, { force: true });
  execFileSync("zip", ["-r", "-q", "-X", out, `${profileId}.sdProfile`], { cwd: tmp });
  rmSync(tmp, { recursive: true, force: true });

  console.log(`Generated ${out}`);
  console.log("  8 keys -> com.mrshu.muxboard.attention, 4 dials -> com.mrshu.muxboard.dial");
}

main();
