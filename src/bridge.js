#!/usr/bin/env node
"use strict";

// Superbase bridge.
// - WebSocket endpoint for the executor clients (roblox/client.lua). Several Roblox clients can
//   be connected at the same time, each one gets an id (c1, c2, ...).
// - Local HTTP API used by the MCP server (or any other tool) to read logs and errors,
//   send commands to a game, take screenshots and check the connection.
// - Serves roblox/client.lua at /client.lua so the executor can load it with loadstring,
//   and a small dashboard at /.
// By default everything binds to 127.0.0.1. With the "host" setting (SUPERBASE_HOST) the bridge can listen on a
// network address instead, so the executor, the bridge and the AI can run on different computers. That needs a token.
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
const terminal = require("./terminal");
const { loadSettings, ROOT, isExposedHost, unbracket, connectHost } = require("./config");
const background = require("./background");
const updateCheck = require("./update-check");
const recipes = require("./recipes");
const { PollHub } = require("./poll-transport");
const { captureRobloxWindow, ScreenshotError } = require("./screenshot");

let WebSocketServer;
try {
  ({ WebSocketServer } = require("ws"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  console.error("[superbase] The dependency 'ws' is not installed yet.");
  console.error("[superbase] Run this once in the Superbase folder, then start the bridge again:");
  console.error("[superbase]   npm install");
  process.exit(1);
}

const VERSION = "1.4.1";
const settings = loadSettings(process.env);
const HOST = unbracket(settings.host); // what the server binds to
const EXPOSED = isExposedHost(HOST); // other computers can reach it
const SHOWN_HOST = connectHost(settings.host); // what to put in a URL on this computer
const PORT = settings.port;
const TOKEN = settings.token;
const OPEN_MODE = TOKEN === "";
const MAX_ENTRIES = 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const MIN_COMMAND_TIMEOUT_MS = 1000;
const MAX_COMMAND_TIMEOUT_MS = 120000;
const PROBE_TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 1024 * 1024;
const PING_INTERVAL_MS = settings.pingMs;
const STALE_AFTER_MS = settings.staleMs;
const STARTED_AT = Date.now();

// In a terminal the bridge prints a styled startup screen and one line per event, with the time.
// When the output goes to a file or a pipe, or SUPERBASE_PLAIN is set, it prints the plain lines.
const FANCY = Boolean(process.stdout.isTTY) && !settings.plain;
const ui = terminal.makeUi(FANCY && !process.env.NO_COLOR, FANCY && terminal.supportsUnicode(process.platform, process.env));

// kind: ok, warn, fail or info. "debug" lines are only printed in plain mode.
function note(kind, text) {
  if (!FANCY) {
    console.log(`[superbase] ${text}`);
    return;
  }
  if (kind === "debug") return;
  const time = new Date().toTimeString().slice(0, 8);
  const symbol = { ok: ui.green(ui.sym.ok), warn: ui.yellow(ui.sym.warn), fail: ui.red(ui.sym.fail) }[kind] || ui.dim(ui.sym.dot);
  console.log(`  ${ui.dim(time)}  ${symbol} ${text}`);
}

const CLIENT_SCRIPT_CANDIDATES = [
  path.join(__dirname, "..", "roblox", "client.lua"),
  path.join(__dirname, "client.lua"),
];
const DASHBOARD_DIR = path.join(__dirname, "dashboard");
const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");
const ICON_FILE = path.join(__dirname, "..", "assets", "icon.png");

// Everything the dashboard loads, by exact URL. Nothing else is ever read from disk for a web request,
// so there is no way to ask for another file with ../ or an encoded path.
const DASHBOARD_FILES = new Map([
  ["/", { file: path.join(DASHBOARD_DIR, "index.html"), type: "text/html; charset=utf-8", page: true }],
  ["/dashboard.css", { file: path.join(DASHBOARD_DIR, "dashboard.css"), type: "text/css; charset=utf-8" }],
  ["/dashboard.js", { file: path.join(DASHBOARD_DIR, "dashboard.js"), type: "text/javascript; charset=utf-8" }],
  ["/theme-init.js", { file: path.join(DASHBOARD_DIR, "theme-init.js"), type: "text/javascript; charset=utf-8" }],
  ["/fonts/BuilderSans-Regular-400.otf", { file: path.join(FONT_DIR, "BuilderSans-Regular-400.otf"), type: "font/otf", cache: "max-age=3600" }],
  ["/fonts/BuilderIcons-Regular.ttf", { file: path.join(FONT_DIR, "BuilderIcons-Regular.ttf"), type: "font/ttf", cache: "max-age=3600" }],
  ["/fonts/BuilderIcons-Filled.ttf", { file: path.join(FONT_DIR, "BuilderIcons-Filled.ttf"), type: "font/ttf", cache: "max-age=3600" }],
]);

if (EXPOSED && OPEN_MODE) {
  console.error(`The bridge would listen on ${HOST}, which other computers can reach, and it has no token.`);
  console.error("Set BRIDGE_TOKEN (16 characters or more) first, or use host 127.0.0.1. Generate a token with:");
  console.error("node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"");
  process.exit(1);
}

if (!OPEN_MODE && (TOKEN === "PASTE_YOUR_TOKEN_HERE" || TOKEN.length < 16)) {
  console.error("BRIDGE_TOKEN must be at least 16 characters. Unset it to use open mode, or generate one with:");
  console.error("node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"");
  process.exit(1);
}

const logs = [];
const errors = [];
const clients = new Map(); // client id -> authenticated WebSocket, in connection order
const pending = new Map(); // command id -> { resolve, reject, timer, ws }
const pendingPings = new Map(); // ping id -> { sentAt, ws, resolve?, reject?, timer? }
let clientSequence = 0;
let entrySequence = 0; // gives every stored log and error a unique, increasing id
let lastDisconnectAt = null;
let lastDisconnectReason = null; // "teleport" when the client said goodbye before it left

function findClientScript() {
  return CLIENT_SCRIPT_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

// A string literal for Lua, safe for any token.
function luaString(text) {
  let out = "";
  for (const byte of Buffer.from(String(text), "utf8")) {
    out += byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c ? String.fromCharCode(byte) : `\\${String(byte).padStart(3, "0")}`;
  }
  return `"${out}"`;
}

// The script served to the executor points at this bridge. A client on another computer gets the address it
// used to reach the bridge (the Host header). In token mode the token is only served to a caller that has it.
function readClientScript(hostHeader, token) {
  const file = findClientScript();
  if (!file) return null;
  const address = EXPOSED && typeof hostHeader === "string" && /^[A-Za-z0-9.:\-\[\]]+$/.test(hostHeader) ? hostHeader : `${SHOWN_HOST}:${PORT}`;
  let script = fs.readFileSync(file, "utf8").replace(/Url = "ws:\/\/[^"]*"/, () => `Url = "ws://${address}"`);
  if (token) script = script.replace(/Token = "[^"]*"/, () => `Token = ${luaString(token)}`);
  return script;
}

const RECIPES_DIR = recipes.recipesDir(settings, ROOT);
// What to run in the executor. In token mode the token goes after ?token= (the executor cannot send headers).
const CLIENT_URL = OPEN_MODE && findClientScript() ? `http://${SHOWN_HOST}:${PORT}/client.lua` : null;
const TOKEN_CLIENT_LINE = !OPEN_MODE && findClientScript() ? `loadstring(game:HttpGet("http://${SHOWN_HOST}:${PORT}/client.lua?token=YOUR_TOKEN"))()` : null;

function pushBounded(list, entry) {
  list.push(entry);
  if (list.length > MAX_ENTRIES) {
    list.shift();
  }
}

function removeWhere(list, predicate) {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) list.splice(index, 1);
  }
}

function tokenMatches(provided) {
  const a = Buffer.from(String(provided || ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLive(ws) {
  return Boolean(ws && ws.authenticated && ws.readyState === 1);
}

function liveClients() {
  return [...clients.values()].filter(isLive);
}

// With no id, commands go to the client that connected last.
function pickClient(id) {
  if (id) {
    const ws = clients.get(String(id));
    return isLive(ws) ? ws : null;
  }
  const live = liveClients();
  return live.length > 0 ? live[live.length - 1] : null;
}

function describeClients() {
  const live = liveClients();
  const fallback = live.length > 0 ? live[live.length - 1] : null;
  const now = Date.now();
  return live.map((ws) => ({
    id: ws.id,
    isDefault: ws === fallback,
    placeId: ws.meta.placeId,
    jobId: ws.meta.jobId,
    userId: ws.userId,
    userName: ws.userName,
    executor: ws.executor,
    clientVersion: ws.clientVersion,
    transport: ws.polling ? "polling" : "websocket",
    connectedForSec: Math.round((now - ws.connectedAt) / 1000),
    lastSeenMsAgo: now - ws.lastSeen,
    latencyMs: typeof ws.latencyMs === "number" ? ws.latencyMs : null,
  }));
}

function noClientError(id) {
  if (id) {
    const ids = liveClients().map((ws) => ws.id);
    return new Error(`Unknown client '${id}'. Connected clients: ${ids.length > 0 ? ids.join(", ") : "none"}`);
  }
  return new Error("No executor is connected");
}

function cleanText(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 100) : null;
}

function cleanNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rejectAllPending(ws, reason) {
  for (const [id, entry] of pending) {
    if (entry.ws !== ws) continue;
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
  for (const [id, entry] of pendingPings) {
    if (entry.ws !== ws) continue;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.reject) entry.reject(new Error(reason));
    pendingPings.delete(id);
  }
}

function clampTimeout(raw) {
  const number = Number(raw);
  if (!Number.isFinite(number)) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(MIN_COMMAND_TIMEOUT_MS, Math.round(number)));
}

// Sends a command to an executor and resolves with { ok, value, error }.
function sendCommand(type, payload, { client, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const ws = pickClient(client);
    if (!ws) {
      reject(noClientError(client));
      return;
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds waiting for the executor`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer, ws });
    ws.send(JSON.stringify({ ...payload, type, id }));
  });
}

// Pings an executor and resolves with the round trip time in milliseconds.
function probe(ws) {
  return new Promise((resolve, reject) => {
    if (!isLive(ws)) {
      reject(new Error("No executor is connected"));
      return;
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingPings.delete(id);
      reject(new Error("The executor did not answer the ping"));
    }, PROBE_TIMEOUT_MS);

    pendingPings.set(id, { sentAt: Date.now(), ws, resolve, reject, timer });
    ws.send(JSON.stringify({ type: "ping", id }));
  });
}

function handlePong(ws, message) {
  let id = message.id;
  if (id === undefined) {
    // Older clients do not echo the ping id, so answer the oldest outstanding ping of this client.
    for (const [pendingId, entry] of pendingPings) {
      if (entry.ws === ws) {
        id = pendingId;
        break;
      }
    }
  }

  const entry = pendingPings.get(id);
  if (!entry || entry.ws !== ws) return;

  pendingPings.delete(id);
  ws.latencyMs = Date.now() - entry.sentAt;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.resolve) entry.resolve(ws.latencyMs);
}

function handleClientMessage(ws, message) {
  switch (message.type) {
    case "log":
      pushBounded(logs, {
        id: ++entrySequence,
        time: Date.now(),
        client: ws.id,
        level: String(message.level || "info"),
        message: String(message.message ?? ""),
        history: message.history === true,
      });
      break;
    case "error":
      pushBounded(errors, {
        id: ++entrySequence,
        time: Date.now(),
        client: ws.id,
        message: String(message.message ?? ""),
        trace: String(message.trace ?? ""),
        script: message.script ? String(message.script) : null,
      });
      break;
    case "goodbye":
      // The client says why it is about to leave, for example because the game is teleporting.
      ws.goodbye = String(message.reason || "").slice(0, 40);
      break;
    case "result": {
      const entry = pending.get(message.id);
      if (entry && entry.ws === ws) {
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

// Describes the selected client (the requested one, or the one that connected last).
function connectionInfo(requestedId, target) {
  const now = Date.now();
  const unknown = Boolean(requestedId) && !target;
  const live = Boolean(target);
  return {
    state: unknown ? "unknown_client" : live ? "connected" : "waiting_for_roblox",
    connected: live,
    mode: OPEN_MODE ? "open" : "token",
    clientUrl: CLIENT_URL,
    selectedClient: live ? target.id : null,
    requestedClient: requestedId || null,
    clientCount: liveClients().length,
    clients: describeClients(),
    place: live ? target.meta : null,
    executor: live ? target.executor : null,
    clientVersion: live ? target.clientVersion : null,
    userName: live ? target.userName : null,
    connectedForSec: live ? Math.round((now - target.connectedAt) / 1000) : null,
    lastSeenMsAgo: live ? now - target.lastSeen : null,
    latencyMs: live && typeof target.latencyMs === "number" ? target.latencyMs : null,
    lastDisconnectedSecAgo: !live && lastDisconnectAt ? Math.round((now - lastDisconnectAt) / 1000) : null,
    lastDisconnectReason: !live && lastDisconnectAt ? lastDisconnectReason : null,
    logCount: logs.length,
    errorCount: errors.length,
    bridgeVersion: VERSION,
    bridgePid: process.pid,
    update: updateCheck.current(),
    bridgeUptimeSec: Math.round((now - STARTED_AT) / 1000),
  };
}

// Filters stored entries by time (since, in ms, inclusive so nothing in the same millisecond is
// missed), by client, by text (contains) and, for logs, by level.
function filterEntries(entries, url, useLevel) {
  const since = Number(url.searchParams.get("since")) || 0;
  const contains = (url.searchParams.get("contains") || "").slice(0, 200).toLowerCase();
  const level = useLevel ? url.searchParams.get("level") : null;
  const client = url.searchParams.get("client");

  return entries.filter((entry) => {
    if (since && entry.time < since) return false;
    if (client && entry.client !== client) return false;
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

// The dashboard may only be shown as a top level page and only talks to this bridge.
// Styles, scripts and fonts all come from the bridge itself, so the policy needs no 'unsafe-inline'.
const DASHBOARD_CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendDashboardFile(res, entry) {
  let body;
  try {
    body = fs.readFileSync(entry.file);
  } catch {
    // A missing font only costs looks: the page falls back to system fonts and hides its icons.
    sendJson(res, 404, { error: `${path.relative(path.join(__dirname, ".."), entry.file).split(path.sep).join("/")} was not found` });
    return;
  }

  const headers = {
    "Content-Type": entry.type,
    "Content-Length": body.length,
    "Cache-Control": entry.cache || "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (entry.page) {
    headers["Content-Security-Policy"] = DASHBOARD_CSP;
    headers["X-Frame-Options"] = "DENY";
    headers["Referrer-Policy"] = "no-referrer";
  }
  res.writeHead(200, headers);
  res.end(body);
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
  // A bridge that other computers can reach is protected by its token, and clients use whatever address they have.
  if (EXPOSED) return typeof hostHeader === "string" && hostHeader !== "";
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

function originAllowed(origin, hostHeader) {
  if (OWN_ORIGINS.has(origin)) return true;
  if (!EXPOSED || typeof hostHeader !== "string") return false;
  // An executor that sends the bridge's own address as the Origin. A web page sends its own site instead.
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}

// Open mode needs a custom header that a web page cannot add without a CORS preflight.
function authorized(req) {
  if (OPEN_MODE) {
    return typeof req.headers["x-superbase-client"] === "string";
  }
  return tokenMatches(req.headers["x-bridge-token"]);
}

// Executors without a WebSocket talk to the bridge over HTTP instead (see poll-transport.js). Their sessions go
// through the same connection handler as WebSocket clients.
const polling = new PollHub({ attach: (session) => wss.emit("connection", session) });

const server = http.createServer(async (req, res) => {
  try {
    // Blocks DNS rebinding and requests that are not aimed at the local bridge.
    if (!hostAllowed(req.headers.host)) {
      sendJson(res, 403, { error: "Forbidden host" });
      return;
    }

    // Blocks web pages. Browsers always attach their own origin to cross-origin requests.
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin, req.headers.host)) {
      sendJson(res, 403, { error: "Forbidden origin" });
      return;
    }

    // Never approve a CORS preflight, so a web page cannot send custom headers.
    if (req.method === "OPTIONS") {
      sendJson(res, 403, { error: "Preflight requests are not allowed" });
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    // The dashboard page, its styles, script and fonts hold no data. The page loads everything through the API below.
    if (req.method === "GET" && DASHBOARD_FILES.has(url.pathname)) {
      sendDashboardFile(res, DASHBOARD_FILES.get(url.pathname));
      return;
    }

    // The dashboard shows the project icon when assets/icon.png exists. It is public, like the page.
    if (route === "GET /icon.png") {
      let icon;
      try {
        icon = fs.readFileSync(ICON_FILE);
      } catch {
        // No icon in this copy of the project: answer quietly, the page hides the image.
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": icon.length,
        "Cache-Control": "max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(icon);
      return;
    }

    // The executor loads this with loadstring(game:HttpGet(...)), so it cannot send headers.
    if (route === "GET /client.lua") {
      // In token mode the executor passes the token in the address, because game:HttpGet cannot send headers.
      const provided = url.searchParams.get("token");
      const allowed = OPEN_MODE || tokenMatches(provided);
      const script = allowed ? readClientScript(req.headers.host, OPEN_MODE ? "" : provided) : null;
      if (script === null) {
        sendJson(res, 404, {
          error: allowed
            ? "roblox/client.lua was not found next to the bridge"
            : "In token mode load the client with /client.lua?token=<your token>, or copy it into your executor and set CONFIG.Token.",
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
      const requested = url.searchParams.get("client");
      const target = pickClient(requested);
      let responsive = null;
      if (url.searchParams.get("probe") === "1" && target) {
        try {
          await probe(target);
          responsive = true;
        } catch {
          responsive = false;
        }
      }
      const info = connectionInfo(requested, target);
      if (responsive !== null) info.responsive = responsive;
      sendJson(res, 200, info);
    } else if (route === "GET /clients") {
      sendJson(res, 200, { clients: describeClients() });
    } else if (route === "GET /logs") {
      const limit = clampLimit(url.searchParams.get("limit"), 100);
      sendJson(res, 200, { now: Date.now(), logs: filterEntries(logs, url, true).slice(-limit) });
    } else if (route === "GET /errors") {
      const limit = clampLimit(url.searchParams.get("limit"), 50);
      sendJson(res, 200, { now: Date.now(), errors: filterEntries(errors, url, false).slice(-limit) });
    } else if (route === "POST /clear") {
      const body = await readJsonBody(req);
      const only = typeof body.client === "string" && body.client.length > 0 ? body.client : null;
      removeWhere(logs, (entry) => !only || entry.client === only);
      removeWhere(errors, (entry) => !only || entry.client === only);
      sendJson(res, 200, { cleared: true, client: only });
    } else if (route === "POST /exec") {
      const body = await readJsonBody(req);
      if (typeof body.code !== "string" || body.code.length === 0) {
        sendJson(res, 400, { error: "Field 'code' must be a non-empty string" });
        return;
      }
      sendJson(
        res,
        200,
        await sendCommand("exec", { code: body.code }, { client: body.client, timeoutMs: clampTimeout(body.timeout_ms) }),
      );
    } else if (route === "POST /inspect") {
      const body = await readJsonBody(req);
      const inspectPath = typeof body.path === "string" && body.path.length > 0 ? body.path : "game";
      const properties = Array.isArray(body.properties) ? body.properties.map(String) : [];
      sendJson(
        res,
        200,
        await sendCommand(
          "inspect",
          { path: inspectPath, properties },
          { client: body.client, timeoutMs: clampTimeout(body.timeout_ms) },
        ),
      );
    } else if (route === "POST /poll/hello") {
      const body = await readJsonBody(req);
      const result = polling.hello(body, OPEN_MODE ? undefined : req.headers["x-bridge-token"]);
      if (result.error) sendJson(res, result.status, { error: result.error });
      else sendJson(res, 200, { session: result.session });
    } else if (route === "GET /poll/next") {
      const result = await polling.next(url.searchParams.get("session"), url.searchParams.get("wait"));
      if (result) sendJson(res, 200, result);
      else sendJson(res, 404, { error: "Unknown session", closed: true });
    } else if (route === "POST /poll/send") {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.messages)) {
        sendJson(res, 400, { error: "Field 'messages' must be an array" });
      } else if (polling.push(url.searchParams.get("session"), body.messages)) {
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 404, { error: "Unknown session", closed: true });
      }
    } else if (route === "POST /poll/close") {
      sendJson(res, 200, { ok: polling.close(url.searchParams.get("session")) });
    } else if (route === "GET /recipes") {
      sendJson(res, 200, { dir: RECIPES_DIR, recipes: recipes.list(RECIPES_DIR) });
    } else if (req.method === "GET" && url.pathname.startsWith("/recipes/")) {
      try {
        sendJson(res, 200, recipes.read(RECIPES_DIR, decodeURIComponent(url.pathname.slice("/recipes/".length))));
      } catch (error) {
        sendJson(res, error instanceof recipes.RecipeError ? 404 : 400, { error: error.message });
      }
    } else if (route === "GET /screenshot") {
      try {
        const shot = await captureRobloxWindow({
          maxWidth: url.searchParams.get("max_width") || undefined,
          focus: url.searchParams.get("focus") === "1",
        });
        sendJson(res, 200, { ok: true, ...shot });
      } catch (error) {
        sendJson(res, error instanceof ScreenshotError ? error.status : 500, { error: error.message });
      }
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
    if (origin && !originAllowed(origin, req.headers.host)) {
      note("warn", `rejected connection with Origin header: ${origin}`);
      return false;
    }
    return true;
  },
});

wss.on("connection", (ws) => {
  ws.authenticated = false;
  note("debug", "new connection, waiting for hello");

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
        ws.meta = { placeId: message.placeId ?? null, jobId: message.jobId ?? null };
        ws.userId = cleanNumber(message.userId);
        ws.userName = cleanText(message.userName);
        ws.executor = cleanText(message.executor);
        ws.clientVersion = cleanText(message.clientVersion);

        // The same player in the same server that connects again replaces the old connection,
        // for example after running the loader twice. Other clients stay connected.
        if (ws.userId !== null) {
          for (const other of liveClients()) {
            if (other.userId === ws.userId && other.meta.jobId === ws.meta.jobId && other.meta.placeId === ws.meta.placeId) {
              other.close(1000, "Replaced by a newer connection");
            }
          }
        }

        clientSequence += 1;
        ws.id = `c${clientSequence}`;
        ws.authenticated = true;
        ws.connectedAt = Date.now();
        ws.lastSeen = ws.connectedAt;
        ws.latencyMs = null;
        clearTimeout(authTimer);
        clients.set(ws.id, ws);

        ws.send(JSON.stringify({ type: "welcome", clientId: ws.id }));
        note("ok", `executor connected as ${ws.id} (placeId=${ws.meta.placeId}, executor=${ws.executor || "unknown"}, user=${ws.userName || "unknown"})`);

        // Measure the first round trip shortly after the client finished sending its history.
        setTimeout(() => {
          if (isLive(ws)) probe(ws).catch(() => {});
        }, 1000);
      } else {
        note("warn", "rejected hello (wrong token or malformed message)");
        ws.close(1008, "Unauthorized");
      }
      return;
    }

    ws.lastSeen = Date.now();
    if (message.type === "pong") {
      handlePong(ws, message);
      return;
    }
    handleClientMessage(ws, message);
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (ws.id && clients.get(ws.id) === ws) {
      clients.delete(ws.id);
      lastDisconnectAt = Date.now();
      lastDisconnectReason = ws.goodbye || null;
      rejectAllPending(ws, "Executor disconnected");
      note("info", `executor ${ws.id} disconnected${ws.goodbye ? ` (${ws.goodbye})` : ""}`);
    }
  });

  ws.on("error", () => {});
});

// Heartbeat: keeps the latency fresh and drops a client that went silent, for example
// when the game was force closed and the socket never reported it.
const heartbeat = setInterval(() => {
  const now = Date.now();

  for (const ws of liveClients()) {
    if (now - ws.lastSeen > STALE_AFTER_MS) {
      note("warn", `executor ${ws.id} stopped responding, closing the connection`);
      ws.terminate();
      continue;
    }

    const id = crypto.randomUUID();
    pendingPings.set(id, { sentAt: now, ws });
    ws.send(JSON.stringify({ type: "ping", id }));
  }

  // Heartbeat pings carry no timer, so drop the ones that were never answered.
  for (const [id, entry] of pendingPings) {
    if (!entry.timer && now - entry.sentAt > STALE_AFTER_MS) {
      pendingPings.delete(id);
    }
  }
}, PING_INTERVAL_MS);
heartbeat.unref();

// A port that is taken is the most common reason the bridge does not start, so it gets a clear message.
let failedToStart = false;
async function onServerError(error) {
  if (failedToStart) return;
  failedToStart = true;
  const next = PORT + 1;
  const retry = process.platform === "win32" ? `$env:SUPERBASE_PORT = "${next}"; npm start` : `SUPERBASE_PORT=${next} npm start`;
  if (error.code === "EADDRINUSE") {
    // Most of the time the port is taken by another Superbase bridge, often the one that runs in the background.
    const other = await background.probe(PORT, TOKEN);
    const lines = other && !other.unauthorized
      ? [
          `A Superbase bridge is already running on port ${PORT}${other.bridgePid ? ` (process ${other.bridgePid})` : ""}.`,
          "Use it, or stop it first with: npm run stop",
        ]
      : [`Port ${PORT} is already in use by another program.`, `Close it, or use another port: ${retry}`, "The MCP server needs the same port, so set SUPERBASE_PORT there too."];
    if (FANCY) {
      console.log("");
      console.log(`  ${ui.red(ui.sym.fail)} ${ui.bold(lines[0])}`);
      for (const line of lines.slice(1)) console.log(`    ${ui.dim(line)}`);
      console.log("");
    } else {
      console.error(`[superbase] ${lines.join(" ")}`);
    }
  } else {
    console.error(`[superbase] The bridge could not start: ${error.message}`);
  }
  process.exit(1);
}
server.on("error", onServerError);
wss.on("error", onServerError);

// Leave cleanly, so the state file of the background bridge does not point at a process that is gone.
process.on("exit", () => background.clearState(process.env, ROOT, process.pid));
process.on("SIGTERM", () => process.exit(0));
if (FANCY) {
  process.on("SIGINT", () => {
    console.log("");
    note("info", "Bridge stopped");
    console.log("");
    process.exit(0);
  });
} else {
  process.on("SIGINT", () => process.exit(0));
}

function announceUpdate(result) {
  if (!result || !result.available) return;
  note("ok", `Update available: ${result.latest} (you have ${VERSION}). Run npm run update, details: ${result.url}`);
}

server.listen(PORT, HOST, () => {
  try {
    background.writeState(process.env, ROOT, { pid: process.pid, port: PORT, version: VERSION, startedAt: new Date(STARTED_AT).toISOString() });
  } catch {
    // The state file only helps npm run stop and status. The bridge works without it.
  }

  if (!FANCY) {
    console.log(`[superbase] bridge ${VERSION} listening on ws://${HOST}:${PORT} (HTTP API on the same port)`);
    console.log(`[superbase] dashboard: http://${SHOWN_HOST}:${PORT}/`);
    if (EXPOSED) console.log("[superbase] network mode: other computers can reach this bridge, the token is required for every request.");
    if (settings.file) console.log(`[superbase] settings from ${settings.file}`);
    for (const warning of settings.warnings) console.log(`[superbase] warning: ${warning}`);
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
      if (TOKEN_CLIENT_LINE) console.log(`[superbase] load the client in your executor with: ${TOKEN_CLIENT_LINE} (put your token in place of YOUR_TOKEN)`);
    }
  } else {
    const row = (label, value) => console.log(`  ${ui.green(ui.sym.live)} ${ui.bold(label.padEnd(12))}${value}`);
    terminal.banner(ui, `Superbase Bridge ${VERSION}`, "Roblox executor and AI, connected", (line) => console.log(line));
    row("Running", `ws://${HOST}:${PORT}`);
    row("Dashboard", ui.cyan(`http://${SHOWN_HOST}:${PORT}/`));
    if (OPEN_MODE) {
      row("Mode", `open ${ui.dim("(no token, web pages are blocked)")}`);
    } else {
      row("Mode", `token ${ui.dim("(every request must carry the token)")}`);
    }
    if (settings.file) row("Settings", ui.dim(path.basename(settings.file)));
    console.log("");
    for (const warning of settings.warnings) console.log(`  ${ui.yellow(ui.sym.warn)} ${warning}`);
    if (settings.warnings.length > 0) console.log("");
    if (OPEN_MODE && CLIENT_URL) {
      console.log(`  ${ui.bold("Load this in your executor")}`);
      console.log(`    ${ui.cyan(`loadstring(game:HttpGet("${CLIENT_URL}"))()`)}`);
      console.log("");
    } else if (TOKEN_CLIENT_LINE) {
      console.log(`  ${ui.bold("Load this in your executor")} ${ui.dim("(put your token in place of YOUR_TOKEN)")}`);
      console.log(`    ${ui.cyan(TOKEN_CLIENT_LINE)}`);
      console.log("");
    } else if (OPEN_MODE) {
      console.log(`  ${ui.yellow(ui.sym.warn)} roblox/client.lua was not found, so /client.lua is not available.`);
      console.log("");
    }
    console.log(`  ${ui.dim("Waiting for a Roblox client. Press Ctrl+C to stop.")}`);
    console.log("");
  }

  // Run in the background (started by the MCP server or by superbase start): show the tray icon on Windows.
  if (process.env.SUPERBASE_BACKGROUND === "1") {
    const tray = require("./tray").start(
      { settings: { ...settings, port: PORT, host: HOST, token: TOKEN }, version: VERSION, logFile: background.locations(process.env, ROOT).log },
      { log: (line) => console.log(`[superbase] ${line}`) },
    );
    if (tray.started) process.on("exit", () => tray.stop());
  }

  if (settings.updateCheck) {
    updateCheck
      .check({ current: VERSION, cacheFile: path.join(background.locations(process.env, ROOT).dir, "update.json") })
      .then(announceUpdate)
      .catch(() => {});
  }
});
