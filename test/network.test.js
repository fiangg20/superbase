"use strict";

// The host setting: a bridge other computers can reach needs a token, and serves the client with it.

const { spawn, spawnSync } = require("child_process");
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const BRIDGE = path.join(__dirname, "..", "src", "bridge.js");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-network-test-"));
const TOKEN = "network-test-token-1234567890";
const PORT = 18781;
const LOCAL_PORT = 18782;

const baseEnv = (port, extra) => ({
  ...process.env, SUPERBASE_CONFIG: "none", SUPERBASE_AUTOSTART: "0", SUPERBASE_UPDATE_CHECK: "0", SUPERBASE_HOME: HOME,
  SUPERBASE_PORT: String(port), SUPERBASE_TOKEN: "", BRIDGE_PORT: "", BRIDGE_TOKEN: "", SUPERBASE_HOST: "", ...extra,
});

function start(port, extra) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [BRIDGE], { env: baseEnv(port, extra) });
    child.stdout.on("data", (data) => { if (data.toString().includes("listening")) resolve(child); });
    child.stderr.on("data", (data) => reject(new Error(data.toString())));
  });
}

// fetch cannot change the Host header, http.request can.
function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  // Without a token the bridge refuses to listen on a network address.
  const refused = spawnSync("node", [BRIDGE], { env: baseEnv(PORT, { SUPERBASE_HOST: "0.0.0.0" }), encoding: "utf8", timeout: 10000 });
  assert.strictEqual(refused.status, 1);
  assert.ok(/no token/.test(refused.stderr), refused.stderr);
  const refusedShort = spawnSync("node", [BRIDGE], { env: baseEnv(PORT, { SUPERBASE_HOST: "0.0.0.0", SUPERBASE_TOKEN: "short" }), encoding: "utf8", timeout: 10000 });
  assert.strictEqual(refusedShort.status, 1, "a short token is refused too");

  const exposed = await start(PORT, { SUPERBASE_HOST: "0.0.0.0", SUPERBASE_TOKEN: TOKEN });
  const local = await start(LOCAL_PORT, { SUPERBASE_TOKEN: TOKEN });
  try {
    const auth = { "x-bridge-token": TOKEN };

    // Clients use whatever address they reached the bridge with.
    let res = await request(PORT, "/status", { ...auth, host: `pc.lan:${PORT}` });
    assert.strictEqual(res.status, 200, "any Host header works on a network bridge");
    res = await request(PORT, "/status", { host: `pc.lan:${PORT}` });
    assert.strictEqual(res.status, 401, "but the token is still needed");
    res = await request(PORT, "/status", { ...auth, host: `pc.lan:${PORT}`, Origin: "https://evil.example" });
    assert.strictEqual(res.status, 403, "web pages stay blocked");
    res = await request(PORT, "/status", { ...auth, host: `pc.lan:${PORT}`, Origin: `http://pc.lan:${PORT}` });
    assert.strictEqual(res.status, 200, "an executor that sends the bridge's own address as Origin works");
    res = await request(PORT, "/status", { ...auth, host: `pc.lan:${PORT}`, Origin: "http://other.lan:1" });
    assert.strictEqual(res.status, 403, "an Origin that is not the bridge's own address is refused");

    // The client script carries the address and the token, and only goes to someone who has the token.
    res = await request(PORT, "/client.lua", { host: `pc.lan:${PORT}` });
    assert.strictEqual(res.status, 404, "no script without the token");
    assert.ok(/\?token=/.test(res.text));
    res = await request(PORT, "/client.lua?token=wrong-token-wrong-token-1234", { host: `pc.lan:${PORT}` });
    assert.strictEqual(res.status, 404);
    res = await request(PORT, `/client.lua?token=${TOKEN}`, { host: `pc.lan:${PORT}` });
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes(`Url = "ws://pc.lan:${PORT}"`), "the client connects to the address it was loaded from");
    assert.ok(res.text.includes(`Token = "${TOKEN}"`), "the token is filled in");
    assert.ok(res.text.includes(`LoaderUrl = "http://pc.lan:${PORT}/client.lua?token=${TOKEN}"`), "so is the address for loading it again after a teleport");
    res = await request(PORT, `/client.lua?token=${TOKEN}`, { host: "bad host" });
    assert.ok(res.status === 200 && res.text.includes(`Url = "ws://127.0.0.1:${PORT}"`), "an odd Host header falls back to the local address");

    // A local bridge in token mode does the same, but only for its own addresses.
    res = await request(LOCAL_PORT, `/client.lua?token=${TOKEN}`, { host: `127.0.0.1:${LOCAL_PORT}` });
    assert.ok(res.status === 200 && res.text.includes(`Token = "${TOKEN}"`));
    res = await request(LOCAL_PORT, "/status", { ...auth, host: `evil.example:${LOCAL_PORT}` });
    assert.strictEqual(res.status, 403, "a loopback bridge still blocks foreign Host headers");
    res = await request(LOCAL_PORT, "/client.lua", { host: `127.0.0.1:${LOCAL_PORT}` });
    assert.strictEqual(res.status, 404);

    // A token with odd characters ends up as a valid Lua string.
    // (checked through the generator the bridge uses, with a fake token in a separate process)
  } finally {
    exposed.kill();
    local.kill();
  }

  // A token with quotes and a backslash survives in the Lua string.
  const odd = 'abc"def\\ghié-1234567890';
  const oddBridge = await start(PORT, { SUPERBASE_HOST: "0.0.0.0", SUPERBASE_TOKEN: odd });
  try {
    const res = await request(PORT, `/client.lua?token=${encodeURIComponent(odd)}`, { host: `pc.lan:${PORT}` });
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('Token = "abc\\034def\\092ghi\\195\\169-1234567890"'), res.text.match(/Token = "[^\n]*/)[0]);
  } finally {
    oddBridge.kill();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log("ALL NETWORK CHECKS PASSED");
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
