"use strict";

// HTTP long polling: a fake executor without WebSocket talks to a real bridge.

const { spawn } = require("child_process");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PollHub } = require("../src/poll-transport");

const BRIDGE = path.join(__dirname, "..", "src", "bridge.js");
const PORT = 18771;
const TOKEN_PORT = 18772;
const STALE_PORT = 18773;
const TOKEN = "polling-test-token-1234567890";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-polling-test-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startBridge(port, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [BRIDGE], {
      env: { ...process.env, SUPERBASE_CONFIG: "none", SUPERBASE_AUTOSTART: "0", SUPERBASE_UPDATE_CHECK: "0", SUPERBASE_HOME: HOME, SUPERBASE_PORT: String(port), SUPERBASE_TOKEN: "", BRIDGE_PORT: "", BRIDGE_TOKEN: "", ...extraEnv },
    });
    child.stdout.on("data", (data) => {
      if (data.toString().includes("listening")) resolve(child);
    });
    child.stderr.on("data", (data) => reject(new Error(data.toString())));
  });
}

// The same calls the Lua client makes.
class PollClient {
  constructor(port, { token, name = "Poller", userId = 9 } = {}) {
    this.base = `http://127.0.0.1:${port}`;
    this.headers = { "content-type": "application/json", ...(token ? { "x-bridge-token": token } : { "x-superbase-client": "poll-test" }) };
    this.hello = { placeId: 7, jobId: "job-poll", userId, userName: name, executor: "NoSocketExec", clientVersion: "9.9.9" };
    this.inbox = [];
  }

  async request(method, url, body) {
    const response = await fetch(`${this.base}${url}`, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => null) };
  }

  async connect() {
    const reply = await this.request("POST", "/poll/hello", this.hello);
    if (reply.status !== 200) return reply;
    this.session = reply.data.session;
    return reply;
  }

  async poll(wait = 0) {
    const reply = await this.request("GET", `/poll/next?session=${this.session}&wait=${wait}`);
    if (reply.status === 200) for (const text of reply.data.messages) this.inbox.push(JSON.parse(text));
    return reply;
  }

  send(...messages) {
    return this.request("POST", `/poll/send?session=${this.session}`, { messages });
  }

  async waitFor(type, { wait = 200, tries = 20 } = {}) {
    for (let i = 0; i <= tries; i += 1) {
      const index = this.inbox.findIndex((message) => message.type === type);
      if (index !== -1) return this.inbox.splice(index, 1)[0];
      if (i < tries) await this.poll(wait);
    }
    throw new Error(`no ${type} message arrived`);
  }
}

const api = async (port, method, url, body, token) => {
  const headers = { "content-type": "application/json", ...(token ? { "x-bridge-token": token } : { "x-superbase-client": "test" }) };
  const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => null) };
};

async function testUnits() {
  // The hub without a bridge: sessions behave like sockets.
  const seen = [];
  const hub = new PollHub({ attach: (session) => {
    session.on("message", (text) => {
      const message = JSON.parse(text);
      seen.push(message);
      if (message.type === "hello" && message.token === "ok") {
        session.authenticated = true;
        session.send(JSON.stringify({ type: "welcome" }));
      }
    });
  }, maxSessions: 2 });
  assert.strictEqual(hub.hello({ userName: "a" }, "wrong").status, 401, "a refused hello gives no session");
  assert.strictEqual(hub.size, 0, "and leaves nothing behind");
  const first = hub.hello({ userName: "a" }, "ok");
  assert.ok(/^[0-9a-f]{32}$/.test(first.session));
  assert.ok(hub.hello({}, "ok").session);
  assert.strictEqual(hub.hello({}, "ok").status, 429, "the number of sessions is limited");
  assert.deepStrictEqual(await hub.next(first.session, 0), { messages: [JSON.stringify({ type: "welcome" })], closed: false });
  assert.deepStrictEqual(await hub.next(first.session, 0), { messages: [], closed: false });
  assert.strictEqual(await hub.next("nope", 0), null);
  assert.strictEqual(hub.push("nope", []), false);
  // A poll that waits is answered as soon as a message is sent.
  const waiting = hub.next(first.session, 5000);
  hub.sessions.get(first.session).send("hello-text");
  assert.deepStrictEqual((await waiting).messages, ["hello-text"]);
  // A newer poll takes over from an older one.
  const older = hub.next(first.session, 5000);
  const newer = hub.next(first.session, 50);
  assert.deepStrictEqual((await older).messages, []);
  assert.deepStrictEqual((await newer).messages, []);
  // Objects and texts both work when pushing, and the batch is bounded.
  hub.push(first.session, ["{\"type\":\"x\"}", { type: "y" }]);
  assert.deepStrictEqual(seen.slice(-2).map((message) => message.type), ["x", "y"]);
  // Closing.
  assert.strictEqual(hub.close(first.session), true);
  assert.strictEqual(hub.close(first.session), false);
  assert.strictEqual(await hub.next(first.session, 0), null);
  assert.strictEqual(hub.size, 1);
  // Waiting is cut at the limit and a closed session answers at once.
  const second = [...hub.sessions.values()][0];
  await hub.next(second.sid, 0);
  const pending = hub.next(second.sid, 999999);
  second.close();
  assert.deepStrictEqual(await pending, { messages: [], closed: true });
  // Too many unpolled messages close the session.
  const third = hub.hello({}, "ok");
  const session = hub.sessions.get(third.session);
  let closed = false;
  session.on("close", () => (closed = true));
  for (let i = 0; i < 2100; i += 1) session.send("m");
  assert.ok(closed, "a client that never polls is dropped");
}

async function testOpenMode() {
  const client = new PollClient(PORT);
  const hello = await client.connect();
  assert.strictEqual(hello.status, 200, JSON.stringify(hello));
  const welcome = await client.waitFor("welcome");
  assert.ok(/^c\d+$/.test(welcome.clientId));

  // The client shows up like any other, and says how it is connected.
  let res = await api(PORT, "GET", "/status");
  assert.strictEqual(res.data.connected, true);
  assert.strictEqual(res.data.executor, "NoSocketExec");
  res = await api(PORT, "GET", "/clients");
  assert.strictEqual(res.data.clients[0].transport, "polling");

  // Logs and errors arrive in a batch.
  await client.send({ type: "log", level: "warn", message: "from the poller" }, { type: "error", message: "boom", trace: "t" });
  res = await api(PORT, "GET", "/logs?contains=poller");
  assert.strictEqual(res.data.logs.length, 1);
  assert.strictEqual((await api(PORT, "GET", "/errors")).data.errors[0].message, "boom");

  // A command goes out on the next poll and the result comes back through /poll/send.
  const exec = api(PORT, "POST", "/exec", { code: "return 1 + 1" });
  const command = await client.waitFor("exec");
  assert.strictEqual(command.code, "return 1 + 1");
  await client.send({ type: "result", id: command.id, ok: true, value: [2] });
  res = await exec;
  assert.deepStrictEqual(res.data, { ok: true, value: [2], error: null });

  // A long poll is answered the moment a command arrives.
  const waiting = client.waitFor("exec", { wait: 5000, tries: 1 });
  await sleep(100);
  const started = Date.now();
  const exec2 = api(PORT, "POST", "/exec", { code: "return 5" });
  const command2 = await waiting;
  assert.ok(Date.now() - started < 1500, "the poll returned right away");
  await client.send({ type: "result", id: command2.id, ok: true, value: [5] });
  assert.strictEqual((await exec2).data.value[0], 5);

  // Pings are answered with a pong, and the latency is measured.
  const probe = api(PORT, "GET", "/status?probe=1");
  const ping = await client.waitFor("ping");
  await client.send({ type: "pong", id: ping.id });
  res = await probe;
  assert.strictEqual(res.data.responsive, true);

  // Empty polls return after the wait and keep the client alive.
  const t0 = Date.now();
  const empty = await client.poll(300);
  assert.deepStrictEqual(empty.data, { messages: [], closed: false });
  assert.ok(Date.now() - t0 >= 250);

  // A goodbye is remembered, then closing ends the session.
  await client.send({ type: "goodbye", reason: "teleport" });
  assert.strictEqual((await client.request("POST", `/poll/close?session=${client.session}`)).data.ok, true);
  res = await api(PORT, "GET", "/status");
  assert.strictEqual(res.data.connected, false);
  assert.strictEqual(res.data.lastDisconnectReason, "teleport");
  assert.strictEqual((await client.poll(0)).status, 404, "a closed session is gone");
  assert.strictEqual((await client.send({ type: "log", message: "late" })).status, 404);

  // The same player connecting again replaces the old polling session.
  const a = new PollClient(PORT, { userId: 55 });
  await a.connect();
  await a.waitFor("welcome");
  const b = new PollClient(PORT, { userId: 55 });
  await b.connect();
  await b.waitFor("welcome");
  const replaced = await a.poll(0);
  assert.ok(replaced.status === 404 || replaced.data.closed === true, "the older session was replaced");
  assert.strictEqual((await api(PORT, "GET", "/clients")).data.clients.length, 1);
  await b.request("POST", `/poll/close?session=${b.session}`);

  // Bad requests.
  assert.strictEqual((await api(PORT, "POST", "/poll/send?session=zzz", { messages: [] })).status, 404);
  const c = new PollClient(PORT, { userId: 56 });
  await c.connect();
  assert.strictEqual((await c.request("POST", `/poll/send?session=${c.session}`, { messages: "no" })).status, 400);
  assert.strictEqual((await c.request("POST", `/poll/send?session=${c.session}`, { messages: [] })).status, 200);
  const noHeader = await fetch(`http://127.0.0.1:${PORT}/poll/hello`, { method: "POST", body: "{}" });
  assert.strictEqual(noHeader.status, 401, "the polling routes need the client header like every other route");
  const foreign = await fetch(`http://127.0.0.1:${PORT}/poll/next?session=x`, { headers: { Origin: "https://evil.example", "x-superbase-client": "x" } });
  assert.strictEqual(foreign.status, 403, "web pages cannot poll");
  await c.request("POST", `/poll/close?session=${c.session}`);
}

async function testTokenMode() {
  const wrong = new PollClient(TOKEN_PORT, { token: "wrong-token-wrong-token-1234" });
  assert.strictEqual((await wrong.connect()).status, 401);
  const none = await fetch(`http://127.0.0.1:${TOKEN_PORT}/poll/hello`, { method: "POST", headers: { "x-superbase-client": "x" }, body: "{}" });
  assert.strictEqual(none.status, 401);
  const good = new PollClient(TOKEN_PORT, { token: TOKEN });
  assert.strictEqual((await good.connect()).status, 200);
  await good.waitFor("welcome");
  assert.strictEqual((await api(TOKEN_PORT, "GET", "/status", undefined, TOKEN)).data.connected, true);
  await good.request("POST", `/poll/close?session=${good.session}`);
}

async function testStale() {
  // A polling client that stops polling is dropped by the heartbeat, like a silent WebSocket.
  const client = new PollClient(STALE_PORT);
  await client.connect();
  await client.waitFor("welcome");
  assert.strictEqual((await api(STALE_PORT, "GET", "/status")).data.connected, true);
  await sleep(1500);
  assert.strictEqual((await api(STALE_PORT, "GET", "/status")).data.connected, false, "a silent polling client is dropped");
  assert.strictEqual((await client.poll(0)).status, 404);

  // One that keeps polling stays.
  const alive = new PollClient(STALE_PORT, { userId: 77 });
  await alive.connect();
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    await alive.poll(100);
    for (const message of alive.inbox.splice(0)) if (message.type === "ping") await alive.send({ type: "pong", id: message.id });
  }
  assert.strictEqual((await api(STALE_PORT, "GET", "/status")).data.connected, true, "polling keeps the client alive");
}

async function main() {
  await testUnits();
  const open = await startBridge(PORT);
  const token = await startBridge(TOKEN_PORT, { SUPERBASE_TOKEN: TOKEN });
  const stale = await startBridge(STALE_PORT, { SUPERBASE_PING_MS: "100", SUPERBASE_STALE_MS: "400" });
  try {
    await testOpenMode();
    await testTokenMode();
    await testStale();
    console.log("ALL POLLING CHECKS PASSED");
  } finally {
    open.kill();
    token.kill();
    stale.kill();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
