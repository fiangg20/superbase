"use strict";

// End-to-end test for the Superbase bridge: starts it in open mode and in token mode
// and talks to it with a fake executor client.

const { spawn } = require("child_process");
const assert = require("assert");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const BRIDGE = path.join(__dirname, "..", "src", "bridge.js");
const PORT = 18765;
const STALE_PORT = 18766;
const TOKEN_PORT = 18767;
const SHORT_TOKEN_PORT = 18768;
const MULTI_PORT = 18769;
const TOKEN = "test-token-1234567890abcdef";
const OPEN_HEADERS = { "x-superbase-client": "test", "content-type": "application/json" };
const TOKEN_HEADERS = { "x-bridge-token": TOKEN, "content-type": "application/json" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startBridge(port, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [BRIDGE], {
      env: {
        ...process.env,
        SUPERBASE_PORT: String(port),
        SUPERBASE_TOKEN: "",
        BRIDGE_PORT: "",
        BRIDGE_TOKEN: "",
        ...extraEnv,
      },
    });
    child.stdout.on("data", (data) => {
      if (data.toString().includes("listening")) resolve(child);
    });
    child.stderr.on("data", (data) => reject(new Error(data.toString())));
  });
}

// A raw request, so the test can set Host and Origin headers that fetch would not allow.
function rawRequest(port, { method = "GET", requestPath = "/status", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function openSocket(port, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

// Connects a fake executor. It answers exec, inspect and (optionally) ping messages.
function connectExecutor(port, { answerPings = true, token } = {}) {
  return new Promise((resolve, reject) => {
    openSocket(port).then((ws) => {
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "welcome") {
          resolve(ws);
        } else if (message.type === "ping" && answerPings) {
          ws.send(JSON.stringify({ type: "pong", id: message.id }));
        } else if (message.type === "exec") {
          ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, value: [`ran: ${message.code}`] }));
        } else if (message.type === "inspect") {
          ws.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: `Not found at segment: ${message.path}` }));
        }
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          token,
          placeId: 123,
          jobId: "abc",
          executor: "TestExec 1.0",
          clientVersion: "9.9.9",
        }),
      );
    }, reject);
  });
}

async function testOpenMode(BASE, stale, STALE_BASE) {
  // 1. Open mode: no token, but a custom header is required.
  let res = await fetch(`${BASE}/status`);
  assert.strictEqual(res.status, 401, "a request without the custom header must return 401");

  res = await fetch(`${BASE}/status`, { headers: OPEN_HEADERS });
  let status = await res.json();
  assert.strictEqual(status.connected, false);
  assert.strictEqual(status.state, "waiting_for_roblox");
  assert.strictEqual(status.mode, "open");
  assert.strictEqual(status.clientUrl, `${BASE}/client.lua`);
  assert.strictEqual(status.lastDisconnectedSecAgo, null);

  // 2. Web pages are blocked: foreign Origin, foreign Host and preflight requests.
  res = await rawRequest(PORT, { headers: { ...OPEN_HEADERS, Origin: "https://evil.example" } });
  assert.strictEqual(res.status, 403, "a foreign Origin must be rejected");
  res = await rawRequest(PORT, { headers: { ...OPEN_HEADERS, Host: "evil.example" } });
  assert.strictEqual(res.status, 403, "a foreign Host must be rejected");
  res = await rawRequest(PORT, { method: "OPTIONS", headers: { Origin: `http://127.0.0.1:${PORT}` } });
  assert.strictEqual(res.status, 403, "a preflight must never be approved");
  res = await rawRequest(PORT, { requestPath: "/client.lua", headers: { Origin: "https://evil.example" } });
  assert.strictEqual(res.status, 403, "client.lua is also protected from foreign origins");

  // 3. /client.lua is served without a header and points at this bridge's port.
  res = await fetch(`${BASE}/client.lua`);
  assert.strictEqual(res.status, 200);
  assert.ok((res.headers.get("content-type") || "").startsWith("text/plain"));
  const script = await res.text();
  assert.ok(script.includes(`Url = "ws://127.0.0.1:${PORT}"`), "the served script must use the bridge's own port");
  assert.ok(!script.includes("9731"), "the default port must be rewritten");
  assert.ok(script.includes("Superbase"));

  // 4. WebSocket with a foreign Origin (browser-like) is rejected.
  await assert.rejects(openSocket(PORT, { headers: { Origin: "https://evil.example" } }));
  await assert.rejects(openSocket(PORT, { headers: { Origin: "http://127.0.0.1:3000" } }));

  // 4b. The bridge's own address as Origin (what Solara sends) is accepted.
  const ownOrigin = await openSocket(PORT, { headers: { Origin: `ws://127.0.0.1:${PORT}` } });
  ownOrigin.close();

  // 4c. A malformed hello is closed.
  const bad = await openSocket(PORT);
  const badClosed = new Promise((resolve) => bad.on("close", (code) => resolve(code)));
  bad.send(JSON.stringify({ type: "nothello" }));
  assert.strictEqual(await badClosed, 1008, "a malformed hello must close with 1008");

  // 5. Handshake without a token, then the fake executor streams logs and an error.
  const ws = await connectExecutor(PORT);
  ws.send(JSON.stringify({ type: "log", level: "info", message: "first line" }));
  await sleep(20);
  res = await fetch(`${BASE}/logs`, { headers: OPEN_HEADERS });
  const firstBody = await res.json();
  assert.strictEqual(typeof firstBody.now, "number", "logs carry a now timestamp");
  const marker = firstBody.now;
  await sleep(20);

  ws.send(JSON.stringify({ type: "log", level: "warn", message: "Hello from executor" }));
  ws.send(JSON.stringify({ type: "error", message: "boom in script", trace: "Script:1", script: "game.Workspace.Test" }));
  await sleep(100);

  res = await fetch(`${BASE}/status`, { headers: OPEN_HEADERS });
  status = await res.json();
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.state, "connected");
  assert.strictEqual(status.place.placeId, 123);
  assert.strictEqual(status.executor, "TestExec 1.0");
  assert.strictEqual(status.clientVersion, "9.9.9");
  assert.strictEqual(status.responsive, undefined, "no probe unless requested");

  // 5b. A probe pings the executor and reports the round trip.
  res = await fetch(`${BASE}/status?probe=1`, { headers: OPEN_HEADERS });
  status = await res.json();
  assert.strictEqual(status.responsive, true);
  assert.strictEqual(typeof status.latencyMs, "number");

  // 5c. Filters: level, contains (case-insensitive) and since.
  res = await fetch(`${BASE}/logs?level=warn`, { headers: OPEN_HEADERS });
  assert.strictEqual((await res.json()).logs.at(-1).message, "Hello from executor");

  res = await fetch(`${BASE}/logs?contains=HELLO`, { headers: OPEN_HEADERS });
  let logBody = await res.json();
  assert.strictEqual(logBody.logs.length, 1);

  res = await fetch(`${BASE}/logs?since=${marker + 1}`, { headers: OPEN_HEADERS });
  logBody = await res.json();
  assert.deepStrictEqual(
    logBody.logs.map((entry) => entry.message),
    ["Hello from executor"],
    "since must hide older entries",
  );

  res = await fetch(`${BASE}/errors?contains=boom`, { headers: OPEN_HEADERS });
  const errorBody = await res.json();
  assert.strictEqual(typeof errorBody.now, "number");
  assert.strictEqual(errorBody.errors.at(-1).message, "boom in script");

  res = await fetch(`${BASE}/errors?contains=nothing-like-this`, { headers: OPEN_HEADERS });
  assert.strictEqual((await res.json()).errors.length, 0);

  // 6. The fake executor answers exec and inspect commands.
  res = await fetch(`${BASE}/exec`, { method: "POST", headers: OPEN_HEADERS, body: JSON.stringify({ code: "return 1" }) });
  assert.deepStrictEqual(await res.json(), { ok: true, value: ["ran: return 1"], error: null });

  res = await fetch(`${BASE}/inspect`, { method: "POST", headers: OPEN_HEADERS, body: JSON.stringify({ path: "game.Missing" }) });
  assert.strictEqual((await res.json()).ok, false);

  res = await fetch(`${BASE}/exec`, { method: "POST", headers: OPEN_HEADERS, body: JSON.stringify({}) });
  assert.strictEqual(res.status, 400, "empty code must return 400");

  // 7. After the executor disconnects, commands fail cleanly and the status says so.
  ws.close();
  await sleep(150);
  res = await fetch(`${BASE}/exec`, { method: "POST", headers: OPEN_HEADERS, body: JSON.stringify({ code: "return 1" }) });
  assert.strictEqual(res.status, 502);

  res = await fetch(`${BASE}/status`, { headers: OPEN_HEADERS });
  status = await res.json();
  assert.strictEqual(status.connected, false);
  assert.strictEqual(typeof status.lastDisconnectedSecAgo, "number");

  res = await fetch(`${BASE}/clear`, { method: "POST", headers: OPEN_HEADERS });
  assert.strictEqual((await res.json()).cleared, true);

  // 8. A client that stops answering is dropped by the heartbeat.
  const silent = await connectExecutor(STALE_PORT, { answerPings: false });
  await sleep(150);
  res = await fetch(`${STALE_BASE}/status`, { headers: OPEN_HEADERS });
  assert.strictEqual((await res.json()).connected, true, "client is connected right after the handshake");

  await sleep(1200);
  res = await fetch(`${STALE_BASE}/status`, { headers: OPEN_HEADERS });
  status = await res.json();
  assert.strictEqual(status.connected, false, "a silent client must be dropped");
  assert.strictEqual(typeof status.lastDisconnectedSecAgo, "number");
  silent.terminate();
}

// A fake executor with an identity. It answers exec after an optional delay, so the test can see
// which client received a command and how timeouts behave.
function connectIdentified(port, { name, userId, jobId = "job", placeId = 5, delayMs = 0 }) {
  return new Promise((resolve, reject) => {
    openSocket(port).then((ws) => {
      ws.clientName = name;
      ws.closedByBridge = false;
      ws.on("close", () => (ws.closedByBridge = true));
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "welcome") {
          ws.clientId = message.clientId;
          resolve(ws);
        } else if (message.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", id: message.id }));
        } else if (message.type === "exec") {
          setTimeout(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, value: [`ran: ${message.code}`, name] }));
          }, delayMs);
        }
      });
      ws.send(JSON.stringify({ type: "hello", placeId, jobId, userId, userName: name, executor: "TestExec 1.0", clientVersion: "1.3.0" }));
    }, reject);
  });
}

async function testMultiClient(BASE) {
  const get = async (urlPath) => (await fetch(`${BASE}${urlPath}`, { headers: OPEN_HEADERS })).json();
  const post = async (urlPath, body) => {
    const res = await fetch(`${BASE}${urlPath}`, { method: "POST", headers: OPEN_HEADERS, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  // The dashboard page is public and locked down, the API behind it is not.
  let res = await fetch(`${BASE}/`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type").startsWith("text/html"));
  assert.ok(res.headers.get("content-security-policy").includes("default-src 'none'"));
  assert.ok(res.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  assert.strictEqual(res.headers.get("x-frame-options"), "DENY");
  assert.strictEqual(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok((await res.text()).includes("Superbase"));
  assert.strictEqual((await rawRequest(MULTI_PORT, { requestPath: "/", headers: { Origin: "https://evil.example" } })).status, 403, "the page is not served to foreign origins");
  assert.strictEqual((await rawRequest(MULTI_PORT, { requestPath: "/", headers: { Host: "evil.example" } })).status, 403, "the page is not served for foreign hosts");
  res = await fetch(`${BASE}/icon.png`);
  assert.ok(res.status === 200 || res.status === 204, "the icon is served when assets/icon.png exists and ignored quietly otherwise");
  if (res.status === 200) assert.strictEqual(res.headers.get("content-type"), "image/png");

  assert.strictEqual((await fetch(`${BASE}/screenshot`)).status, 401, "screenshots need the API header");
  res = await fetch(`${BASE}/screenshot`, { headers: OPEN_HEADERS });
  if (process.platform !== "win32") {
    assert.strictEqual(res.status, 501);
    assert.ok((await res.json()).error.includes("only supported on Windows"));
  }

  // Two players connect: ids, the default client and the status of a chosen client.
  const bob = await connectIdentified(MULTI_PORT, { name: "Bob", userId: 1, jobId: "server-a", delayMs: 0 });
  const alice = await connectIdentified(MULTI_PORT, { name: "Alice", userId: 2, jobId: "server-b" });
  assert.deepStrictEqual([bob.clientId, alice.clientId], ["c1", "c2"]);

  let clients = (await get("/clients")).clients;
  assert.deepStrictEqual(clients.map((client) => [client.id, client.userName, client.isDefault]), [
    ["c1", "Bob", false],
    ["c2", "Alice", true],
  ]);
  assert.strictEqual(clients[0].userId, 1);
  assert.strictEqual(clients[0].executor, "TestExec 1.0");

  let status = await get("/status");
  assert.strictEqual(status.selectedClient, "c2", "without an id the newest client is selected");
  assert.strictEqual(status.clientCount, 2);
  assert.strictEqual(status.userName, "Alice");
  status = await get("/status?client=c1&probe=1");
  assert.strictEqual(status.selectedClient, "c1");
  assert.strictEqual(status.responsive, true);
  status = await get("/status?client=c9");
  assert.strictEqual(status.state, "unknown_client");
  assert.strictEqual(status.connected, false);
  assert.strictEqual(status.requestedClient, "c9");
  assert.strictEqual(status.clients.length, 2, "the answer still lists the clients that exist");

  // Commands are routed by client id.
  assert.deepStrictEqual((await post("/exec", { code: "a" })).body.value, ["ran: a", "Alice"]);
  assert.deepStrictEqual((await post("/exec", { code: "b", client: "c1" })).body.value, ["ran: b", "Bob"]);
  res = await post("/exec", { code: "c", client: "c9" });
  assert.strictEqual(res.status, 502);
  assert.ok(res.body.error.includes("Unknown client 'c9'") && res.body.error.includes("c1, c2"), res.body.error);

  // Logs and errors carry the client and a unique, increasing id.
  bob.send(JSON.stringify({ type: "log", level: "info", message: "from bob" }));
  alice.send(JSON.stringify({ type: "log", level: "warn", message: "from alice" }));
  bob.send(JSON.stringify({ type: "error", message: "bob failed", trace: "t", script: "game.X" }));
  await sleep(150);
  let logs = (await get("/logs")).logs;
  assert.deepStrictEqual(logs.map((entry) => [entry.client, entry.message]), [["c1", "from bob"], ["c2", "from alice"]]);
  const errors = (await get("/errors")).errors;
  assert.strictEqual(errors[0].client, "c1");
  const ids = [...logs, ...errors].map((entry) => entry.id);
  assert.strictEqual(new Set(ids).size, ids.length, "ids are unique across logs and errors");
  assert.ok(logs[1].id > logs[0].id, "ids increase");
  assert.deepStrictEqual((await get("/logs?client=c2")).logs.map((entry) => entry.message), ["from alice"]);
  assert.strictEqual((await get("/logs?client=c9")).logs.length, 0);

  assert.deepStrictEqual((await post("/clear", { client: "c1" })).body, { cleared: true, client: "c1" });
  assert.deepStrictEqual((await get("/logs")).logs.map((entry) => entry.message), ["from alice"], "only that client's entries are cleared");
  assert.strictEqual((await get("/errors")).errors.length, 0);
  assert.deepStrictEqual((await post("/clear", {})).body, { cleared: true, client: null });
  assert.strictEqual((await get("/logs")).logs.length, 0);

  // The same player in the same server connecting again replaces the old connection.
  const bobAgain = await connectIdentified(MULTI_PORT, { name: "Bob", userId: 1, jobId: "server-a" });
  await sleep(150);
  assert.strictEqual(bob.closedByBridge, true, "the old connection of the same player and server is closed");
  assert.strictEqual(alice.closedByBridge, false, "other players are not touched");
  clients = (await get("/clients")).clients;
  assert.deepStrictEqual(clients.map((client) => client.id), ["c2", "c3"]);
  assert.strictEqual(bobAgain.clientId, "c3");
  assert.strictEqual((await post("/exec", { code: "gone", client: "c1" })).status, 502, "the old id no longer exists");

  // The same player in another server is a separate client.
  const bobElsewhere = await connectIdentified(MULTI_PORT, { name: "Bob", userId: 1, jobId: "server-z" });
  assert.strictEqual((await get("/clients")).clients.length, 3);
  bobElsewhere.close();
  await sleep(150);

  // Per-command timeouts, and a disconnect only fails the commands of that client.
  const slow = await connectIdentified(MULTI_PORT, { name: "Slow", userId: 9, jobId: "server-s", delayMs: 1800 });
  const started = Date.now();
  res = await post("/exec", { code: "slow", client: slow.clientId, timeout_ms: 1 });
  assert.strictEqual(res.status, 502);
  assert.ok(res.body.error.includes("Timed out after 1 seconds"), "timeout_ms is raised to the 1 second minimum: " + res.body.error);
  assert.ok(Date.now() - started < 1700, "the short timeout fired before the executor answered");
  res = await post("/exec", { code: "slow", client: slow.clientId, timeout_ms: 5000 });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.value, ["ran: slow", "Slow"], "a longer timeout lets a slow command finish");

  const pendingOnSlow = post("/exec", { code: "will be lost", client: slow.clientId, timeout_ms: 10000 });
  const stillWorks = post("/exec", { code: "fast", client: "c2" });
  await sleep(200);
  slow.terminate();
  res = await pendingOnSlow;
  assert.strictEqual(res.status, 502);
  assert.ok(res.body.error.includes("disconnected"), res.body.error);
  assert.deepStrictEqual((await stillWorks).body.value, ["ran: fast", "Alice"], "the other client is unaffected");

  // Without any client the old message is kept.
  alice.close();
  bobAgain.close();
  await sleep(200);
  res = await post("/exec", { code: "nobody" });
  assert.strictEqual(res.status, 502);
  assert.ok(res.body.error.includes("No executor is connected"));
  status = await get("/status");
  assert.strictEqual(status.state, "waiting_for_roblox");
  assert.strictEqual(status.clientCount, 0);
}

async function testTokenMode(TOKEN_BASE) {
  // Without the token header nothing works, and the custom open mode header is not enough.
  let res = await fetch(`${TOKEN_BASE}/status`);
  assert.strictEqual(res.status, 401);
  res = await fetch(`${TOKEN_BASE}/status`, { headers: OPEN_HEADERS });
  assert.strictEqual(res.status, 401, "the open mode header must not work in token mode");

  res = await fetch(`${TOKEN_BASE}/status`, { headers: TOKEN_HEADERS });
  assert.strictEqual(res.status, 200);
  const status = await res.json();
  assert.strictEqual(status.mode, "token");
  assert.strictEqual(status.clientUrl, null, "no loader URL is offered in token mode");

  // client.lua is not served in token mode.
  res = await fetch(`${TOKEN_BASE}/client.lua`);
  assert.strictEqual(res.status, 404);

  // The handshake needs the token.
  const wrong = await openSocket(TOKEN_PORT);
  const wrongClosed = new Promise((resolve) => wrong.on("close", (code) => resolve(code)));
  wrong.send(JSON.stringify({ type: "hello", token: "wrong-token-wrong-token" }));
  assert.strictEqual(await wrongClosed, 1008, "a wrong token must close with 1008");

  const missing = await openSocket(TOKEN_PORT);
  const missingClosed = new Promise((resolve) => missing.on("close", (code) => resolve(code)));
  missing.send(JSON.stringify({ type: "hello" }));
  assert.strictEqual(await missingClosed, 1008, "a missing token must close with 1008");

  const ws = await connectExecutor(TOKEN_PORT, { token: TOKEN });
  res = await fetch(`${TOKEN_BASE}/status`, { headers: TOKEN_HEADERS });
  assert.strictEqual((await res.json()).connected, true);
  ws.close();
}

async function testShortToken() {
  // A token that is too short must stop the bridge instead of running with weak protection.
  await new Promise((resolve, reject) => {
    const child = spawn("node", [BRIDGE], {
      env: { ...process.env, SUPERBASE_PORT: String(SHORT_TOKEN_PORT), SUPERBASE_TOKEN: "short", BRIDGE_TOKEN: "" },
    });
    let stderr = "";
    child.stderr.on("data", (data) => (stderr += data.toString()));
    child.on("exit", (code) => {
      try {
        assert.strictEqual(code, 1, "a short token must exit with code 1");
        assert.ok(stderr.includes("at least 16"));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const bridge = await startBridge(PORT);
  const stale = await startBridge(STALE_PORT, { SUPERBASE_PING_MS: "100", SUPERBASE_STALE_MS: "400" });
  const tokenBridge = await startBridge(TOKEN_PORT, { SUPERBASE_TOKEN: TOKEN });
  const multiBridge = await startBridge(MULTI_PORT);

  try {
    await testOpenMode(`http://127.0.0.1:${PORT}`, stale, `http://127.0.0.1:${STALE_PORT}`);
    await testMultiClient(`http://127.0.0.1:${MULTI_PORT}`);
    await testTokenMode(`http://127.0.0.1:${TOKEN_PORT}`);
    await testShortToken();
    console.log("ALL BRIDGE CHECKS PASSED");
  } finally {
    bridge.kill();
    stale.kill();
    tokenBridge.kill();
    multiBridge.kill();
  }
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
