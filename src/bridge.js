"use strict";

// Superbase bridge.
// - WebSocket endpoint for the executor client (roblox/client.lua).
// - Local HTTP API used by the MCP server (or any other tool) to read logs and errors,
//   send commands to the game and check the connection.
// - Serves roblox/client.lua at /client.lua so the executor can load it with loadstring.
// Everything binds to 127.0.0.1.
//
// Two modes:
// - Open mode (default): no token. Web pages are still blocked: the Host and Origin headers
//   are checked and every API request needs a custom header, which a browser cannot send
//   cross-origin without a preflight that this server never approves. Any program on this
//   computer can use the bridge.
// - Token mode: set BRIDGE_TOKEN and every request and the executor handshake must carry it.

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const VERSION = "1.2.0";
const HOST = "127.0.0.1";
const PORT = Number(process.env.SUPERBASE_PORT || process.env.BRIDGE_PORT || 9731);
const TOKEN = process.env.SUPERBASE_TOKEN || process.env.BRIDGE_TOKEN || "";
const OPEN_MODE = TOKEN === "";
const MAX_ENTRIES = 1000;
const REQUEST_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 1024 * 1024;
const PING_INTERVAL_MS = Number(process.env.SUPERBASE_PING_MS || 10000);
const STALE_AFTER_MS = Number(process.env.SUPERBASE_STALE_MS || 30000);
const STARTED_AT = Date.now();

const CLIENT_SCRIPT_CANDIDATES = [
  path.join(__dirname, "..", "roblox", "client.lua"),
  path.join(__dirname, "client.lua"),
];

if (!OPEN_MODE && (TOKEN === "PASTE_YOUR_TOKEN_HERE" || TOKEN.length < 16)) {
  console.error("BRIDGE_TOKEN must be at least 16 characters. Unset it to use open mode, or generate one with:");
  console.error("node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"");
  process.exit(1);
}

const logs = [];
const errors = [];
const pending = new Map(); // command id -> { resolve, reject, timer }
const pendingPings = new Map(); // ping id -> { sentAt, resolve?, reject?, timer? }
let client = null;
let lastDisconnectAt = null;

function findClientScript() {
  return CLIENT_SCRIPT_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

// The script served to the executor always points at this bridge's own port.
function readClientScript() {
  const file = findClientScript();
  if (!file) return null;
  return fs.readFileSync(file, "utf8").replace(/Url = "ws:\/\/[^"]*"/, `Url = "ws://${HOST}:${PORT}"`);
}

const CLIENT_URL = OPEN_MODE && findClientScript() ? `http://${HOST}:${PORT}/client.lua` : null;

function pushBounded(list, entry) {
  list.push(entry);
  if (list.length > MAX_ENTRIES) {
    list.shift();
  }
}

function tokenMatches(provided) {
  const a = Buffer.from(String(provided || ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLive() {
  return Boolean(client && client.authenticated && client.readyState === 1);
}

function cleanText(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 100) : null;
}

function rejectAllPending(reason) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
  for (const [id, entry] of pendingPings) {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.reject) entry.reject(new Error(reason));
    pendingPings.delete(id);
  }
}

// Sends a command to the executor and resolves with { ok, value, error }.
function sendCommand(type, payload) {
  return new Promise((resolve, reject) => {
    if (!isLive()) {
      reject(new Error("No executor is connected"));
      return;
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for the executor"));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    client.send(JSON.stringify({ ...payload, type, id }));
  });
}

// Pings the executor and resolves with the round trip time in milliseconds.
function probe() {
  return new Promise((resolve, reject) => {
    if (!isLive()) {
      reject(new Error("No executor is connected"));
      return;
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingPings.delete(id);
      reject(new Error("The executor did not answer the ping"));
    }, PROBE_TIMEOUT_MS);

    pendingPings.set(id, { sentAt: Date.now(), resolve, reject, timer });
    client.send(JSON.stringify({ type: "ping", id }));
  });
}

function handlePong(ws, message) {
  let id = message.id;
  if (id === undefined) {
    // Older clients do not echo the ping id, so answer the oldest outstanding ping.
    id = pendingPings.keys().next().value;
  }

  const entry = pendingPings.get(id);
  if (!entry) return;

  pendingPings.delete(id);
  ws.latencyMs = Date.now() - entry.sentAt;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.resolve) entry.resolve(ws.latencyMs);
}

function handleClientMessage(message) {
  switch (message.type) {
    case "log":
      pushBounded(logs, {
        time: Date.now(),
        level: String(message.level || "info"),
        message: String(message.message ?? ""),
        history: message.history === true,
      });
      break;
    case "error":
      pushBounded(errors, {
        time: Date.now(),
        message: String(message.message ?? ""),
        trace: String(message.trace ?? ""),
        script: message.script ? String(message.script) : null,
      });
      break;
    case "result": {
      const entry = pending.get(message.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(message.id);
        entry.resolve({
          ok: message.ok === true,
          value: message.value ?? null,
          error: message.error ?? null,
        });
      }
      break;
    }
    default:
      break;
  }
}

function connectionInfo() {
  const live = isLive();
  const now = Date.now();
  return {
    state: live ? "connected" : "waiting_for_roblox",
    connected: live,
    mode: OPEN_MODE ? "open" : "token",
    clientUrl: CLIENT_URL,
    place: live ? client.meta : null,
    executor: live ? client.executor : null,
    clientVersion: live ? client.clientVersion : null,
    connectedForSec: live ? Math.round((now - client.connectedAt) / 1000) : null,
    lastSeenMsAgo: live ? now - client.lastSeen : null,
    latencyMs: live && typeof client.latencyMs === "number" ? client.latencyMs : null,
    lastDisconnectedSecAgo: !live && lastDisconnectAt ? Math.round((now - lastDisconnectAt) / 1000) : null,
    logCount: logs.length,
    errorCount: errors.length,
    bridgeVersion: VERSION,
    bridgeUptimeSec: Math.round((now - STARTED_AT) / 1000),
  };
}

// Filters stored entries by time (since, in ms, inclusive so nothing in the same millisecond is
// missed), by text (contains) and, for logs, by level.
function filterEntries(entries, url, useLevel) {
  const since = Number(url.searchParams.get("since")) || 0;
  const contains = (url.searchParams.get("contains") || "").slice(0, 200).toLowerCase();
  const level = useLevel ? url.searchParams.get("level") : null;

  return entries.filter((entry) => {
    if (since && entry.time < since) return false;
    if (level && entry.level !== level) return false;
    if (contains && !`${entry.message}\n${entry.trace || ""}`.toLowerCase().includes(contains)) return false;
    return true;
  });
}

function clampLimit(raw, fallback) {
  return Math.min(Math.max(Number(raw) || fallback, 1), MAX_ENTRIES);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function hostAllowed(hostHeader) {
  return hostHeader === `127.0.0.1:${PORT}` || hostHeader === `localhost:${PORT}`;
}

// Some executors (Solara) send the bridge's own address as the Origin header.
// Web pages always send their own origin, which is never in this set.
const OWN_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `ws://127.0.0.1:${PORT}`,
  `ws://localhost:${PORT}`,
]);

// Open mode needs a custom header that a web page cannot add without a CORS preflight.
function authorized(req) {
  if (OPEN_MODE) {
    return typeof req.headers["x-superbase-client"] === "string";
  }
  return tokenMatches(req.headers["x-bridge-token"]);
}

const server = http.createServer(async (req, res) => {
  try {
    // Blocks DNS rebinding and requests that are not aimed at the local bridge.
    if (!hostAllowed(req.headers.host)) {
      sendJson(res, 403, { error: "Forbidden host" });
      return;
    }

    // Blocks web pages. Browsers always attach their own origin to cross-origin requests.
    const origin = req.headers.origin;
    if (origin && !OWN_ORIGINS.has(origin)) {
      sendJson(res, 403, { error: "Forbidden origin" });
      return;
    }

    // Never approve a CORS preflight, so a web page cannot send custom headers.
    if (req.method === "OPTIONS") {
      sendJson(res, 403, { error: "Preflight requests are not allowed" });
      return;
    }

    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const route = `${req.method} ${url.pathname}`;

    // The executor loads this with loadstring(game:HttpGet(...)), so it cannot send headers.
    if (route === "GET /client.lua") {
      const script = OPEN_MODE ? readClientScript() : null;
      if (script === null) {
        sendJson(res, 404, {
          error: OPEN_MODE
            ? "roblox/client.lua was not found next to the bridge"
            : "client.lua is not served in token mode. Copy it into your executor and set CONFIG.Token.",
        });
        return;
      }
      sendText(res, 200, script);
      return;
    }

    if (!authorized(req)) {
      sendJson(res, 401, {
        error: OPEN_MODE ? "Missing x-superbase-client header" : "Invalid or missing token",
      });
      return;
    }

    if (route === "GET /status") {
      // With ?probe=1 the bridge pings the executor and reports whether it answered.
      let responsive = null;
      if (url.searchParams.get("probe") === "1" && isLive()) {
        try {
          await probe();
          responsive = true;
        } catch {
          responsive = false;
        }
      }
      const info = connectionInfo();
      if (responsive !== null) info.responsive = responsive;
      sendJson(res, 200, info);
    } else if (route === "GET /logs") {
      const limit = clampLimit(url.searchParams.get("limit"), 100);
      sendJson(res, 200, { now: Date.now(), logs: filterEntries(logs, url, true).slice(-limit) });
    } else if (route === "GET /errors") {
      const limit = clampLimit(url.searchParams.get("limit"), 50);
      sendJson(res, 200, { now: Date.now(), errors: filterEntries(errors, url, false).slice(-limit) });
    } else if (route === "POST /clear") {
      logs.length = 0;
      errors.length = 0;
      sendJson(res, 200, { cleared: true });
    } else if (route === "POST /exec") {
      const body = await readJsonBody(req);
      if (typeof body.code !== "string" || body.code.length === 0) {
        sendJson(res, 400, { error: "Field 'code' must be a non-empty string" });
        return;
      }
      sendJson(res, 200, await sendCommand("exec", { code: body.code }));
    } else if (route === "POST /inspect") {
      const body = await readJsonBody(req);
      const inspectPath = typeof body.path === "string" && body.path.length > 0 ? body.path : "game";
      const properties = Array.isArray(body.properties) ? body.properties.map(String) : [];
      sendJson(res, 200, await sendCommand("inspect", { path: inspectPath, properties }));
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
});

const wss = new WebSocketServer({
  server,
  maxPayload: 2 * 1024 * 1024,
  // Rejects connections that carry a foreign Origin, which blocks malicious web pages
  // from reaching the bridge.
  verifyClient: ({ req }) => {
    const origin = req.headers.origin;
    if (origin && !OWN_ORIGINS.has(origin)) {
      console.log(`[superbase] rejected connection with Origin header: ${origin}`);
      return false;
    }
    return true;
  },
});

wss.on("connection", (ws) => {
  ws.authenticated = false;
  console.log("[superbase] new connection, waiting for hello");

  const authTimer = setTimeout(() => {
    if (!ws.authenticated) {
      ws.close(1008, "Authentication timeout");
    }
  }, 5000);

  ws.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!ws.authenticated) {
      if (message.type === "hello" && (OPEN_MODE || tokenMatches(message.token))) {
        ws.authenticated = true;
        clearTimeout(authTimer);

        if (client && client !== ws) {
          client.close(1000, "Replaced by a newer connection");
        }
        client = ws;
        ws.meta = { placeId: message.placeId ?? null, jobId: message.jobId ?? null };
        ws.executor = cleanText(message.executor);
        ws.clientVersion = cleanText(message.clientVersion);
        ws.connectedAt = Date.now();
        ws.lastSeen = ws.connectedAt;
        ws.latencyMs = null;

        ws.send(JSON.stringify({ type: "welcome" }));
        console.log(
          `[superbase] executor connected (placeId=${ws.meta.placeId}, executor=${ws.executor || "unknown"})`,
        );

        // Measure the first round trip shortly after the client finished sending its history.
        setTimeout(() => {
          if (client === ws) probe().catch(() => {});
        }, 1000);
      } else {
        console.log("[superbase] rejected hello (wrong token or malformed message)");
        ws.close(1008, "Unauthorized");
      }
      return;
    }

    ws.lastSeen = Date.now();
    if (message.type === "pong") {
      handlePong(ws, message);
      return;
    }
    handleClientMessage(message);
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (client === ws) {
      client = null;
      lastDisconnectAt = Date.now();
      rejectAllPending("Executor disconnected");
      console.log("[superbase] executor disconnected");
    }
  });

  ws.on("error", () => {});
});

// Heartbeat: keeps the latency fresh and drops a client that went silent, for example
// when the game was force closed and the socket never reported it.
const heartbeat = setInterval(() => {
  if (!isLive()) return;

  const now = Date.now();
  if (now - client.lastSeen > STALE_AFTER_MS) {
    console.log("[superbase] executor stopped responding, closing the connection");
    client.terminate();
    return;
  }

  for (const [id, entry] of pendingPings) {
    if (!entry.timer && now - entry.sentAt > STALE_AFTER_MS) {
      pendingPings.delete(id);
    }
  }

  const id = crypto.randomUUID();
  pendingPings.set(id, { sentAt: now });
  client.send(JSON.stringify({ type: "ping", id }));
}, PING_INTERVAL_MS);
heartbeat.unref();

server.listen(PORT, HOST, () => {
  console.log(`[superbase] bridge ${VERSION} listening on ws://${HOST}:${PORT} (HTTP API on the same port)`);
  if (OPEN_MODE) {
    console.log("[superbase] open mode: no token needed. Web pages are blocked, but any program on this computer can use the bridge.");
    console.log("[superbase] set BRIDGE_TOKEN to require a token instead.");
    if (CLIENT_URL) {
      console.log(`[superbase] load the client in your executor with: loadstring(game:HttpGet("${CLIENT_URL}"))()`);
    } else {
      console.log("[superbase] roblox/client.lua was not found, so /client.lua is not available.");
    }
  } else {
    console.log("[superbase] token mode: every request and the executor handshake must carry the token.");
  }
});
