#!/usr/bin/env node
/**
 * Muxboard cmux bridge.
 *
 * The Stream Deck app launches the plugin outside any cmux session, so cmux's
 * control socket rejects the plugin's calls ("broken pipe"). This bridge runs
 * inside the user's normal session — where cmux works — and exposes a tiny
 * localhost HTTP API the plugin reaches over TCP:
 *
 *   GET  /notifications          -> raw `cmux list-notifications --json`
 *   POST /open?id=<uuid>         -> `cmux open-notification --id <uuid>`
 *   POST /select-workspace?id=.. -> `cmux select-workspace --workspace <id>`
 *   GET  /health                 -> {"status":"ok"}
 *
 * It is a thin proxy: no normalization here (the plugin normalizes), so the
 * cmux contract lives in one place.
 *
 *   node scripts/bridge.mjs               # port 17779
 *   MUXBOARD_BRIDGE_PORT=9999 node …      # custom port
 *   MUXBOARD_CMUX_BIN=/path/to/cmux node … # custom cmux binary
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const PORT = Number(process.env.MUXBOARD_BRIDGE_PORT ?? 17779);
const HOST = "127.0.0.1";

/** Resolve a bare cmux command to an absolute path against known install dirs. */
function resolveCmuxBin(bin) {
  if (isAbsolute(bin) || bin.includes("/")) return bin;
  const dirs = [
    "/Applications/cmux.app/Contents/Resources/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.HOME ? join(process.env.HOME, ".local/bin") : "",
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return bin;
}

const CMUX_BIN = resolveCmuxBin(process.env.MUXBOARD_CMUX_BIN ?? "cmux");

/** Run cmux and resolve with stdout, rejecting on failure. */
function runCmux(args) {
  return new Promise((resolve, reject) => {
    execFile(CMUX_BIN, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function send(res, status, body, contentType = "application/json") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/health") {
      return send(res, 200, JSON.stringify({ status: "ok", cmux: CMUX_BIN }));
    }
    if (req.method === "GET" && path === "/notifications") {
      const out = await runCmux(["list-notifications", "--json"]);
      return send(res, 200, out);
    }
    if (req.method === "POST" && path === "/open") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, JSON.stringify({ error: "missing id" }));
      await runCmux(["open-notification", "--id", id]);
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (req.method === "POST" && path === "/select-workspace") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, JSON.stringify({ error: "missing id" }));
      await runCmux(["select-workspace", "--workspace", id]);
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    return send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (err) {
    const detail = err && err.stderr ? String(err.stderr).slice(0, 300) : String(err?.message ?? err);
    console.error(`[bridge] ${req.method} ${path} failed: ${detail}`);
    return send(res, 502, JSON.stringify({ error: "cmux call failed", detail }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Muxboard bridge listening on http://${HOST}:${PORT} (cmux: ${CMUX_BIN})`);
});
