#!/usr/bin/env node
"use strict";

// Superbase MCP server (stdio transport).
// Connects any MCP-capable AI to one or more live Roblox executor sessions through the local
// Superbase bridge (bridge.js). It has no dependencies.
// stdout is reserved for protocol messages; diagnostics must go to stderr.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { parseSelector, SelectorError } = require("./selector");
const { loadSettings, isLocalHost, connectHost } = require("./config");
const background = require("./background");
const recipeStore = require("./recipes");
const semantic = require("./semantic");
const recipeImport = require("./recipe-import");
const prompts = require("./prompts");

const VERSION = "1.4.0";
const SETTINGS = loadSettings(process.env);
const PORT = SETTINGS.port;
const TOKEN = SETTINGS.token;
// A bridge on another computer (the "host" setting) is reached over the network and is never started from here.
const REMOTE_BRIDGE = !isLocalHost(SETTINGS.host);
const BASE_URL = `http://${connectHost(SETTINGS.host)}:${PORT}`;
// Set this to a public raw URL of roblox/client.lua if you host it somewhere (for example GitHub).
const CLIENT_URL_OVERRIDE = SETTINGS.clientUrl || "";
const RECIPES_DIR = recipeStore.recipesDir(SETTINGS);
for (const warning of SETTINGS.warnings) process.stderr.write(`[superbase] ${warning}\n`);
const LUA_DIR = path.join(__dirname, "lua");
const REQUEST_TIMEOUT_MS = 25000;
const STATUS_TIMEOUT_MS = 6000;
const SCREENSHOT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_CHARS = 50000;
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "superbase", title: "Superbase", version: VERSION };

const INSTRUCTIONS = [
  "Superbase connects you to live Roblox executor sessions on the user's computer.",
  "You can read the console and script errors, search and inspect the instance tree, read and search script sources, spy on remote calls, operate the GUI, take screenshots, change properties and run Lua inside the running game.",
  "",
  "Connection awareness:",
  "- Call roblox_status first in every session, and again whenever a tool fails. It actively pings the Roblox client.",
  "- Every tool result begins with a [Superbase] status line that shows the current connection state.",
  "- States: connected (all tools work); waiting_for_roblox (the bridge runs but no game is connected); unresponsive (a client is connected but does not answer: the game may be frozen, loading or closing); unknown_client (the client id you passed is not connected); bridge_offline (the bridge is not running and could not be started automatically: the hint says why); token_mismatch (the bridge and this MCP config disagree about the token).",
  "- The bridge starts by itself when a tool needs it, so the user does not have to run npm start (it stays available for running the bridge by hand). A note in the status line says when that happened. When that note appears, tell the user in plain words that the bridge now runs in the background, that it keeps running until they stop it (on Windows: right-click the Superbase icon in the tray and choose Stop Superbase; anywhere: npm run stop), and that autostart can be turned off with \"autostart\": false in superbase.config.json. Do not skip this, they have not seen the note unless you say it.",
  "- After a teleport the Roblox client reconnects by itself within a few seconds (when auto reconnect is on). If the state is waiting_for_roblox right after a teleport, call roblox_status again before asking the user to do anything.",
  "- When the state is waiting_for_roblox, the status line contains a one-line loadstring script. Show it to the user in a code block so they can run it in their executor, then wait for them.",
  "- When the state is not connected, do not retry in a loop. Tell the user what is missing and wait for them.",
  "",
  "Several Roblox windows:",
  "- Several clients can be connected at once, each with an id such as c1 or c2. list_clients shows them.",
  "- Every tool that talks to the game accepts a 'client' id. Without it, the client that connected last is used. Pass the id whenever more than one client is connected and the user did not make clear which one they mean.",
  "",
  "Working with the game:",
  "- get_game_info gives an overview. get_hierarchy prints the tree, find_instances searches it (by name, class or a CSS-like selector), inspect_instance reads one instance.",
  "- Scripts: list_scripts lists them, get_script_source reads one, search_scripts greps through all sources (text, Lua pattern or words mode).",
  "- remote_spy records RemoteEvent and RemoteFunction calls: start it, let the user (or gui_interact) trigger the action, read the calls with get, then stop it. With block it can also stop calls to chosen remotes from reaching the server (unblock undoes it).",
  "- gui_interact lists buttons and text boxes, clicks buttons, types into text boxes and triggers click detectors and proximity prompts. screenshot shows what the Roblox window looks like (Windows only).",
  "- player_info lists the players with position, distance, health and items. character_control teleports the local character or walks it to a position, a player or an instance.",
  "- stats measures FPS (average, minimum, 1% low), stutters, memory, ping and world size, with short notes on what looks wrong. snapshot saves the state of part of the tree and later reports what was added, removed or changed, which is the way to see the effect of an action.",
  "- semantic_search finds code by meaning with a local Ollama: index the game once (repeat with offset until done is true), then search with a plain description. It needs Ollama running with the embedding model pulled, and says what is missing. Use search_scripts for exact text.",
  "- recipes lists, runs and saves reusable Lua scripts (a folder of .lua files with a header). Check the list before you write a script for a common task, and save a script as a recipe when the user will want it again.",
  "- Reverse engineering: inspect_code reads the upvalues and constants of a script or of a module function, searches the garbage collector for functions and tables, and lists the handlers connected to a signal. http_spy records the HTTP requests that scripts send (secrets are redacted): start it, let the action happen, read with get. get_script_source, search_scripts and dump results come from a cache in the executor, pass refresh to decompile again.",
  "- call_instance calls a method, fires a RemoteEvent or RemoteFunction, or fires a signal, with Roblox values written as __type objects. wait_for_instance waits until a path exists, for example after a teleport. run_file runs a .lua file from the user's computer in the game. notify shows a short toast in the Roblox window, for example when a long task is finished.",
  "- To check the effect of an action, use execute_lua with capture_logs, or wait_for_log to wait for a specific console line.",
  "- Logs and errors are stored by the bridge, so get_logs and get_errors still work while waiting_for_roblox.",
  "",
  "Selector syntax for find_instances: Type, #Name, [property=value], descendants separated by a space, direct children with >. Examples: RemoteEvent, Model > Part, Part[Anchored=false], TextButton#Play, Frame TextLabel[Text*='coins']. Operators: = != *= (contains) ^= (starts with) $= (ends with) < <= > >=.",
  "",
  "Safety:",
  "- execute_lua, run_file, call_instance, set_property, gui_interact (click, set_text, trigger), remote_spy and http_spy change or observe the running game with the executor's full permissions. Only do what the user asked for, and explain anything that changes the game or the user's files before you do it. character_control moves the player and recipes (save) writes a file in the recipes folder, so treat them the same way.",
  "- If the bridge runs on another computer (the host setting), it is never started automatically: tell the user to start it there.",
  "- Instance paths are dotted and start at game. Instance names that contain a dot cannot be addressed.",
].join("\n");

const BRIDGE_DOWN_STATES = new Set(["bridge_offline", "token_mismatch", "bridge_error"]);

class BridgeError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function loaderFor(status) {
  const url = CLIENT_URL_OVERRIDE || (status && status.clientUrl) || null;
  return url ? `loadstring(game:HttpGet("${url}"))()` : null;
}

function describeClientList(status) {
  const list = (status && status.clients) || [];
  if (list.length === 0) return "none";
  return list.map((client) => `${client.id}${client.userName ? ` (${client.userName})` : ""}`).join(", ");
}

function hintFor(state, status, autostartError) {
  switch (state) {
    case "bridge_offline":
      if (REMOTE_BRIDGE) {
        return `The Superbase bridge at ${BASE_URL} is not reachable. It runs on another computer, so it is not started automatically. Ask the user to start it there (host 0.0.0.0 or its network address, plus a token) and to check the firewall for port ${PORT}.`;
      }
      if (autostartError) {
        return `The Superbase bridge is not running on ${BASE_URL} and could not be started automatically: ${autostartError} Ask the user to run npm start in the Superbase folder and tell you what it prints.`;
      }
      if (!SETTINGS.autostart) {
        return `The Superbase bridge is not running on ${BASE_URL}, and automatic start is turned off. Ask the user to start it (npm start, or npm run start:bg, in the Superbase folder).`;
      }
      return `The Superbase bridge is not running on ${BASE_URL}. Ask the user to start it (npm start in the Superbase folder).`;
    case "token_mismatch":
      return TOKEN
        ? "The bridge rejected this server's token. BRIDGE_TOKEN in the MCP config must match the token the bridge was started with."
        : "The bridge requires a token. Set BRIDGE_TOKEN in the MCP config to the token the bridge was started with, or restart the bridge without a token.";
    case "waiting_for_roblox": {
      if (status && status.lastDisconnectReason === "teleport" && typeof status.lastDisconnectedSecAgo === "number" && status.lastDisconnectedSecAgo < 120) {
        return "The game is teleporting. The Roblox client reconnects by itself when the new place has loaded, so call roblox_status again in a few seconds. Only ask the user to run the loader again if it stays disconnected for a minute or more.";
      }
      const loader = loaderFor(status);
      return loader
        ? `The bridge is running but no Roblox client is connected. Ask the user to join a game and run this in their executor: ${loader}`
        : "The bridge is running but no Roblox client is connected. Ask the user to join a game and execute roblox/client.lua in their executor.";
    }
    case "unresponsive":
      return "A Roblox client is connected but did not answer a ping. The game may be frozen, loading or closing. Ask the user to check the game.";
    case "unknown_client":
      return `Client '${status && status.requestedClient}' is not connected. Connected clients: ${describeClientList(status)}. Call list_clients to see them.`;
    default:
      return null;
  }
}

async function bridgeRequest(method, urlPath, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const headers = { "x-superbase-client": "mcp", "content-type": "application/json" };
  if (TOKEN) headers["x-bridge-token"] = TOKEN;

  let response;
  try {
    response = await fetch(`${BASE_URL}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new BridgeError("bridge_error", `The bridge did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw new BridgeError("bridge_offline", hintFor("bridge_offline"));
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new BridgeError("bridge_error", `The bridge returned a non-JSON response (HTTP ${response.status}).`);
  }

  if (response.status === 401) {
    throw new BridgeError("token_mismatch", hintFor("token_mismatch"));
  }
  if (!response.ok) {
    throw new BridgeError("bridge_error", data.error || `The bridge returned HTTP ${response.status}.`);
  }
  return data;
}

// Starts the bridge in the background when it is not running. One attempt at a time, and a failed
// attempt is not repeated for 30 seconds, so a broken setup does not slow down every tool call.
const autostart = { promise: null, at: 0, result: null, notice: null };

async function autostartBridge() {
  if (!SETTINGS.autostart || REMOTE_BRIDGE) return null;
  if (autostart.promise) return autostart.promise;
  const age = Date.now() - autostart.at;
  if (autostart.result && !autostart.result.ok && age < 30000) return autostart.result;
  if (autostart.result && autostart.result.ok && age < 3000) return autostart.result;

  autostart.at = Date.now();
  autostart.promise = background
    .startBridge({ settings: SETTINGS, env: process.env })
    .catch((error) => ({ ok: false, started: false, error: error.message }))
    .then((result) => {
      autostart.result = result;
      autostart.at = Date.now();
      if (result.ok && result.started) {
        autostart.notice = `[Superbase] The bridge was not running, so it was started in the background${result.pid ? ` (pid ${result.pid})` : ""}. It keeps running after you close the AI client until you stop it (on Windows with Stop Superbase in the tray icon, or with npm run stop), and "autostart": false in superbase.config.json turns this off. Log: ${background.locations(process.env).log}`;
      }
      return result;
    })
    .finally(() => {
      autostart.promise = null;
    });
  return autostart.promise;
}

// Works out what the AI can do right now. With probe, the bridge pings the Roblox client.
// With a client id, the answer is about that client.
async function assessConnection(probe, client, afterAutostart = false) {
  try {
    const query = new URLSearchParams();
    if (probe) query.set("probe", "1");
    if (client) query.set("client", client);
    const suffix = query.toString();
    const status = await bridgeRequest("GET", `/status${suffix ? `?${suffix}` : ""}`, undefined, STATUS_TIMEOUT_MS);

    let state = "waiting_for_roblox";
    if (status.state === "unknown_client") {
      state = "unknown_client";
    } else if (status.connected) {
      state = status.responsive === false ? "unresponsive" : "connected";
    }

    const connection = { ...status, state, ready: state === "connected" };
    if (state === "waiting_for_roblox") {
      connection.loader = loaderFor(status);
    }
    if (state !== "connected") {
      connection.hint = hintFor(state, status);
    }
    return connection;
  } catch (error) {
    const state = error.kind === "bridge_offline" || error.kind === "token_mismatch" ? error.kind : "bridge_error";
    let autostartError;
    if (state === "bridge_offline" && !afterAutostart) {
      const started = await autostartBridge();
      if (started && started.ok) return assessConnection(probe, client, true);
      if (started) autostartError = started.error;
    }
    return { state, ready: false, hint: hintFor(state, null, autostartError) || error.message };
  }
}

function statusLine(connection) {
  if (connection.state === "connected") {
    const parts = [];
    if (connection.selectedClient) {
      parts.push(connection.userName ? `${connection.selectedClient} (${connection.userName})` : connection.selectedClient);
    }
    if (connection.place && connection.place.placeId) parts.push(`place ${connection.place.placeId}`);
    if (connection.executor) parts.push(connection.executor);
    if (typeof connection.latencyMs === "number") parts.push(`${connection.latencyMs} ms`);
    if (connection.clientCount > 1) parts.push(`${connection.clientCount} clients connected`);
    return `[Superbase] ● connected${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
  }
  return `[Superbase] ○ ${connection.state}: ${connection.hint}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

// Writes text as a Lua string literal made of plain ASCII and \ddd byte escapes, so any
// character (quotes, newlines, unicode) survives without breaking the generated code.
function luaString(text) {
  let out = '"';
  for (const byte of Buffer.from(text, "utf8")) {
    if (byte === 0x22 || byte === 0x5c || byte < 0x20 || byte >= 0x7f) {
      out += `\\${String(byte).padStart(3, "0")}`;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return `${out}"`;
}

function loadSnippet(name) {
  try {
    return fs.readFileSync(path.join(LUA_DIR, `${name}.lua`), "utf8");
  } catch {
    throw new Error(`The Lua snippet ${name}.lua is missing from ${LUA_DIR}.`);
  }
}

// Runs a Lua file from src/lua in the executor. The arguments arrive as a table named args.
// A snippet reports a problem by returning { error = "..." }, which becomes a tool error.
// With timeoutMs the call may take longer than the default 15 seconds.
async function runSnippet(name, args, options = {}) {
  return runLua(loadSnippet(name), args, options);
}

// Runs Lua source with the arguments available as a table named args.
async function runLua(source, args, { client, timeoutMs } = {}) {
  const code = `local args = game:GetService("HttpService"):JSONDecode(${luaString(JSON.stringify(args))})\n${source}`;
  const result = await execOnClient(code, { client, timeoutMs });

  if (result.ok && Array.isArray(result.value) && result.value.length > 0) {
    const first = result.value[0];
    if (first && typeof first === "object" && typeof first.error === "string") {
      return { ok: false, value: null, error: first.error };
    }
    if (result.value.length === 1) {
      return { ok: true, value: first, error: null };
    }
  }
  return result;
}

function execOnClient(code, { client, timeoutMs } = {}) {
  const body = { code };
  if (client) body.client = client;
  if (timeoutMs) body.timeout_ms = timeoutMs;
  // The bridge waits for the executor, so this request must outlast the command timeout.
  const requestTimeout = timeoutMs ? timeoutMs + 5000 : REQUEST_TIMEOUT_MS;
  return bridgeRequest("POST", "/exec", body, requestTimeout);
}

// --- semantic_search ---------------------------------------------------------------------------------------------

const semanticStore = new semantic.IndexStore(path.join(background.locations(process.env).dir, "semantic"));
const embedOptions = () => ({ url: SETTINGS.ollamaUrl, model: SETTINGS.embedModel });

function describeIndex(placeId, meta) {
  return {
    placeId,
    model: meta.model,
    scripts: meta.scripts,
    chunks: meta.count,
    indexedAt: meta.indexedAt,
    complete: meta.nextOffset === null || meta.nextOffset === undefined,
    nextOffset: meta.nextOffset ?? null,
  };
}

async function semanticAction(args, ctx) {
  const wanted = args.place_id === undefined ? null : String(args.place_id);

  if (args.action === "status") {
    const ids = wanted ? [wanted] : semanticStore.list();
    const indexes = [];
    for (const id of ids) {
      const found = semanticStore.load(id);
      if (found) indexes.push(describeIndex(id, found.meta));
    }
    return { model: SETTINGS.embedModel, ollama: SETTINGS.ollamaUrl, indexes };
  }

  if (args.action === "clear") {
    const ids = wanted ? [wanted] : semanticStore.list();
    const removed = ids.filter((id) => semanticStore.remove(id));
    return { removed };
  }

  if (args.action === "search") {
    if (typeof args.query !== "string" || args.query.trim() === "") throw new Error("'query' must be a non-empty string.");
    const placeId = wanted || semanticStore.list()[0];
    const found = placeId ? semanticStore.load(placeId) : null;
    if (!found) {
      return { ok: false, value: null, error: wanted ? `There is no index for place ${wanted}. Run semantic_search with action index first.` : "Nothing is indexed yet. Run semantic_search with action index in the game first." };
    }
    if (found.meta.model !== SETTINGS.embedModel) {
      return { ok: false, value: null, error: `The index was built with ${found.meta.model} but the model is now ${SETTINGS.embedModel}. Run action index again (offset 0) or set embedModel back.` };
    }
    const [query] = await semantic.embed([semantic.formatInput(SETTINGS.embedModel, "query", args.query)], embedOptions());
    const contains = typeof args.path_contains === "string" ? args.path_contains.toLowerCase() : "";
    const hits = semantic.topMatches(found.vectors, query, clampInt(args.k, 1, 30, 8), (index) => !contains || found.meta.chunks[index].path.toLowerCase().includes(contains));
    return {
      placeId,
      model: found.meta.model,
      indexedAt: found.meta.indexedAt,
      complete: found.meta.nextOffset === null || found.meta.nextOffset === undefined,
      searched: found.vectors.length,
      results: hits.map(({ index, score }) => {
        const chunk = found.meta.chunks[index];
        return { score: Math.round(score * 1000) / 1000, path: chunk.path, className: chunk.className, lines: `${chunk.start}-${chunk.end}`, text: chunk.text };
      }),
    };
  }

  // index
  const budgetMs = clampInt(args.budget_seconds, 10, 300, 100) * 1000;
  const maxScripts = clampInt(args.max_scripts, 1, 3000, 400);
  const startedAt = Date.now();
  let offset = clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  await semantic.embed(["ping"], embedOptions()); // fails early and clearly when Ollama or the model is missing

  let chunks = [];
  let vectors = [];
  let scriptCount = 0;
  let placeId = null;
  let existing = null;
  let processed = 0;
  let unreadable = 0;
  let total = 0;
  let nextOffset = offset;

  while (true) {
    const page = await runSnippet(
      "dump_scripts",
      { offset, root: args.root, class_name: args.class_name, include_hidden: args.include_hidden === true },
      { ...ctx, timeoutMs: 60000 },
    );
    if (!page.ok) return page;
    const data = page.value;
    placeId = String(data.placeId);
    total = data.total;
    unreadable += data.unreadable || 0;

    if (existing === null) {
      if (offset === 0) {
        existing = { fresh: true };
      } else {
        const found = semanticStore.load(placeId);
        if (!found) return { ok: false, value: null, error: `There is no index for place ${placeId} to continue. Start again with offset 0.` };
        if (found.meta.model !== SETTINGS.embedModel) return { ok: false, value: null, error: `The index was built with ${found.meta.model}, not ${SETTINGS.embedModel}. Start again with offset 0.` };
        chunks = found.meta.chunks;
        vectors = found.vectors;
        scriptCount = found.meta.scripts || 0;
        existing = found;
      }
    }

    const pageChunks = [];
    for (const script of data.scripts) {
      for (const piece of semantic.chunkSource(script.source)) {
        pageChunks.push({ path: script.path, className: script.className, start: piece.start, end: piece.end, text: piece.text });
      }
    }
    const inputs = pageChunks.map((chunk) => semantic.formatInput(SETTINGS.embedModel, "document", chunk.text, chunk.path));
    const embedded = await semantic.embed(inputs, embedOptions());
    chunks = chunks.concat(pageChunks);
    vectors = vectors.concat(embedded);
    scriptCount += data.scripts.length;
    processed += data.scripts.length;
    nextOffset = data.nextOffset === undefined || data.nextOffset === null ? null : data.nextOffset;

    // Save after every page, so a long run keeps its progress.
    semanticStore.save(placeId, {
      model: SETTINGS.embedModel,
      placeId,
      indexedAt: new Date().toISOString(),
      scripts: scriptCount,
      nextOffset,
      chunks,
    }, vectors);

    if (nextOffset === null || processed >= maxScripts || Date.now() - startedAt > budgetMs) break;
    offset = nextOffset;
  }

  return {
    ok: true,
    value: {
      placeId,
      model: SETTINGS.embedModel,
      scriptsThisCall: processed,
      scriptsIndexed: scriptCount,
      chunks: chunks.length,
      unreadable,
      totalScripts: total,
      done: nextOffset === null,
      nextOffset,
      note: nextOffset === null ? "The index is complete. Use action search." : `More scripts are left. Call index again with offset ${nextOffset}.`,
    },
    error: null,
  };
}

// run_file: the file must be a small text file with a Lua extension.
const MAX_LUA_FILE_BYTES = 500 * 1024;
function readLuaFile(requested) {
  const expanded = requested === "~" || requested.startsWith("~/") || requested.startsWith("~\\")
    ? path.join(require("os").homedir(), requested.slice(1))
    : requested;
  const resolved = path.resolve(expanded);
  if (![".lua", ".luau", ".txt"].includes(path.extname(resolved).toLowerCase())) {
    throw new Error(`${resolved} is not a .lua, .luau or .txt file.`);
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`There is no file at ${resolved}.`);
  }
  if (!stat.isFile()) throw new Error(`${resolved} is not a file.`);
  if (stat.size > MAX_LUA_FILE_BYTES) {
    throw new Error(`${resolved} is ${Math.ceil(stat.size / 1024)} KB, more than the limit of ${MAX_LUA_FILE_BYTES / 1024} KB.`);
  }
  const source = fs.readFileSync(resolved, "utf8");
  if (source.trim().length === 0) throw new Error(`${resolved} is empty.`);
  return { path: resolved, source, bytes: stat.size };
}

function requirePath(args) {
  if (typeof args.path !== "string" || args.path.length === 0) {
    throw new Error("'path' must be a non-empty string.");
  }
  return args.path;
}

function logQuery(args, extra = {}) {
  const query = new URLSearchParams();
  const values = { ...extra };
  for (const key of ["limit", "level", "contains", "since", "client"]) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== "") values[key] = args[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

async function waitForLog(args) {
  const contains = typeof args.contains === "string" ? args.contains : "";
  if (contains.length === 0) {
    throw new Error("'contains' must be a non-empty string.");
  }

  const timeoutMs = clampInt(args.timeout_ms, 100, 30000, 10000);
  const includeErrors = args.include_errors !== false;
  const startedAt = Date.now();
  const since = (await bridgeRequest("GET", "/logs?limit=1")).now;

  while (true) {
    const logs = (await bridgeRequest("GET", `/logs${logQuery({ contains, level: args.level, client: args.client }, { since, limit: 50 })}`)).logs;

    let errors = [];
    if (includeErrors) {
      errors = (await bridgeRequest("GET", `/errors${logQuery({ contains, client: args.client }, { since, limit: 50 })}`)).errors;
    }

    if (logs.length > 0 || errors.length > 0) {
      return { matched: true, waitedMs: Date.now() - startedAt, logs, errors };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { matched: false, waitedMs: Date.now() - startedAt, logs: [], errors: [] };
    }
    await sleep(250);
  }
}

const CLIENT_PROPERTY = {
  type: "string",
  description: "Client id from list_clients, for example c2. Defaults to the client that connected last.",
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

const tools = [
  {
    name: "roblox_status",
    title: "Roblox connection status",
    description:
      "Check whether Superbase is connected to a running Roblox game. Actively pings the Roblox client and returns the connection state (connected, waiting_for_roblox, unresponsive, unknown_client, bridge_offline or token_mismatch), the connected clients, the place, the executor, the latency and the number of stored logs and errors. While waiting_for_roblox it also returns the loadstring script the user must run. Call this first.",
    inputSchema: { type: "object", properties: { client: CLIENT_PROPERTY }, additionalProperties: false },
    annotations: READ_ONLY,
    probe: true,
    reportsConnection: true,
  },
  {
    name: "list_clients",
    title: "List Roblox clients",
    description:
      "List every Roblox client connected to the bridge (several windows or accounts can be connected at once): id, player, place, server, executor, latency and which one is the default. Pass an id as the 'client' argument of the other tools to pick one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    run: () => bridgeRequest("GET", "/clients"),
  },
  {
    name: "get_game_info",
    title: "Get game info",
    description:
      "Get an overview of the running game: place name and creator, server job id, the local player, the player list and performance (physics FPS, memory, ping). Requires the connected state.",
    inputSchema: { type: "object", properties: { client: CLIENT_PROPERTY }, additionalProperties: false },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) => runSnippet("game_info", {}, ctx),
  },
  {
    name: "get_logs",
    title: "Read console logs",
    description:
      "Read recent console output captured from the Roblox executor. The newest entries come last, and the result has a now timestamp you can pass as since next time. Works while waiting_for_roblox because the bridge stores the logs.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum number of entries (default 100)." },
        level: { type: "string", enum: ["info", "warn", "error"], description: "Only return entries of this level." },
        contains: { type: "string", description: "Only return entries whose text contains this (case-insensitive)." },
        since: { type: "integer", description: "Only return entries from this timestamp (in milliseconds) onward." },
        client: { type: "string", description: "Only return entries from this client id (default: all clients)." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: (args) => bridgeRequest("GET", `/logs${logQuery(args)}`),
  },
  {
    name: "get_errors",
    title: "Read script errors",
    description:
      "Read recent script errors captured from the Roblox executor, including the stack trace and the script path. Works while waiting_for_roblox because the bridge stores the errors.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum number of entries (default 50)." },
        contains: { type: "string", description: "Only return errors whose message or trace contains this (case-insensitive)." },
        since: { type: "integer", description: "Only return errors from this timestamp (in milliseconds) onward." },
        client: { type: "string", description: "Only return errors from this client id (default: all clients)." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: (args) => bridgeRequest("GET", `/errors${logQuery({ ...args, level: undefined })}`),
  },
  {
    name: "wait_for_log",
    title: "Wait for a console line",
    description:
      "Wait until a new console line (or script error) that contains the given text appears, then return it. Use it after an action to confirm its effect. Returns matched false when the timeout passes. Requires the bridge, and only sees lines that arrive after the call starts.",
    inputSchema: {
      type: "object",
      properties: {
        contains: { type: "string", description: "Text to wait for (case-insensitive)." },
        timeout_ms: { type: "integer", minimum: 100, maximum: 30000, description: "How long to wait (default 10000)." },
        level: { type: "string", enum: ["info", "warn", "error"], description: "Only match console lines of this level." },
        include_errors: { type: "boolean", description: "Also match script errors (default true)." },
        client: { type: "string", description: "Only match lines from this client id (default: all clients)." },
      },
      required: ["contains"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: waitForLog,
  },
  {
    name: "execute_lua",
    title: "Run Lua in Roblox",
    description:
      "Run Lua code inside the connected Roblox executor. Returns the serialized return values, or the error with a traceback. Set capture_logs to also get the console lines and script errors that appeared while it ran. Use timeout_ms for code that takes long. The code runs with the executor's full permissions, so only run code the user asked for. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Lua source code to run. Use 'return' to get a value back." },
        capture_logs: {
          type: "boolean",
          description: "Also return the console lines and script errors produced during the run (default false).",
        },
        wait_ms: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          description: "With capture_logs: how long to keep collecting after the code finished (default 500).",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description: "How long to wait for the code to finish (default 15000).",
        },
        client: CLIENT_PROPERTY,
      },
      required: ["code"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    writes: true,
    needsRoblox: true,
    run: async (args, ctx) => {
      if (typeof args.code !== "string" || args.code.length === 0) {
        throw new Error("'code' must be a non-empty string.");
      }
      const options = { client: ctx.client, timeoutMs: args.timeout_ms === undefined ? undefined : clampInt(args.timeout_ms, 1000, 120000, 15000) };
      if (args.capture_logs !== true) {
        return execOnClient(args.code, options);
      }

      const waitMs = clampInt(args.wait_ms, 0, 5000, 500);
      const since = (await bridgeRequest("GET", "/logs?limit=1")).now;
      const result = await execOnClient(args.code, options);
      await sleep(waitMs);
      const scope = ctx.client ? { client: ctx.client } : {};
      const logs = (await bridgeRequest("GET", `/logs${logQuery(scope, { since, limit: 200 })}`)).logs;
      const errors = (await bridgeRequest("GET", `/errors${logQuery(scope, { since, limit: 50 })}`)).errors;
      return { ...result, logs, errors };
    },
  },
  {
    name: "inspect_instance",
    title: "Inspect a Roblox instance",
    description:
      "Inspect a Roblox Instance by dotted path (for example game.Workspace.Map.Part). Returns its class, selected properties and children. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Dotted path starting at game. Defaults to game." },
        properties: {
          type: "array",
          items: { type: "string" },
          description: "Property names to read. Defaults to Name, ClassName and Parent.",
        },
        client: CLIENT_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) =>
      bridgeRequest("POST", "/inspect", {
        path: typeof args.path === "string" && args.path.length > 0 ? args.path : "game",
        properties: Array.isArray(args.properties) ? args.properties.map(String) : [],
        client: ctx.client,
      }),
  },
  {
    name: "get_hierarchy",
    title: "Print the instance tree",
    description:
      "Print the instance tree under a path as an indented outline (name and class per line), like the Explorer panel. Use it to get to know a game quickly. Limit it with depth (default 3), max_nodes and max_children, or show only the branches that lead to a class with class_name. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Dotted path to start at (default game)." },
        depth: { type: "integer", minimum: 1, maximum: 8, description: "How many levels to show (default 3)." },
        max_nodes: { type: "integer", minimum: 10, maximum: 1000, description: "Stop after this many lines (default 300)." },
        max_children: { type: "integer", minimum: 1, maximum: 200, description: "Show at most this many children per node (default 40)." },
        class_name: { type: "string", description: "Only show branches that contain an instance of this class (base classes included)." },
        client: CLIENT_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) =>
      runSnippet(
        "get_hierarchy",
        {
          root: args.root,
          depth: clampInt(args.depth, 1, 8, 3),
          max_nodes: clampInt(args.max_nodes, 10, 1000, 300),
          max_children: clampInt(args.max_children, 1, 200, 40),
          class_name: args.class_name,
        },
        ctx,
      ),
  },
  {
    name: "find_instances",
    title: "Find instances",
    description:
      "Search the instance tree. Use a CSS-like selector (for example Model > Part[Anchored=false], TextButton#Play, Frame TextLabel[Text*='coins'], RemoteEvent) or the simple name and class_name filters. Returns the full path and class of each match, optionally with property values, and whether the result list was cut off. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description:
            "Selector made of Type, #Name and [property operator value] parts. A space means any descendant, > means a direct child. Operators: = != *= ^= $= < <= > >=. A property can also be an attribute.",
        },
        root: { type: "string", description: "Dotted path to search under (default game)." },
        name: { type: "string", description: "Case-insensitive part of the instance name." },
        class_name: {
          type: "string",
          description: "Class to match, base classes included (for example BasePart, RemoteEvent or LocalScript).",
        },
        properties: {
          type: "array",
          items: { type: "string" },
          maxItems: 8,
          description: "Property names to return for every match (at most 8).",
        },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum number of results (default 50)." },
        client: CLIENT_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) => {
      if (!args.selector && !args.name && !args.class_name) {
        throw new Error("Provide 'selector', 'name', 'class_name' or a combination.");
      }

      let steps;
      if (args.selector !== undefined && args.selector !== "") {
        try {
          steps = parseSelector(args.selector);
        } catch (error) {
          if (error instanceof SelectorError) throw new Error(`Invalid selector: ${error.message}`);
          throw error;
        }
      }

      return runSnippet(
        "find_instances",
        {
          root: args.root,
          name: args.name,
          class_name: args.class_name,
          steps,
          properties: Array.isArray(args.properties) ? args.properties.slice(0, 8).map(String) : undefined,
          limit: clampInt(args.limit, 1, 200, 50),
        },
        ctx,
      );
    },
  },
  {
    name: "list_scripts",
    title: "List scripts",
    description:
      "List the Scripts, LocalScripts and ModuleScripts of the game with their path, class and whether they are disabled. With include_hidden it also finds scripts that are not in the tree (nil parented instances, loaded modules, running scripts) when the executor supports it. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Dotted path to search under (default game)." },
        class_name: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], description: "Only list this kind of script." },
        name: { type: "string", description: "Case-insensitive part of the script name." },
        include_hidden: { type: "boolean", description: "Also list scripts outside the tree (default false)." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Maximum number of scripts (default 100)." },
        client: CLIENT_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) =>
      runSnippet(
        "list_scripts",
        {
          root: args.root,
          class_name: args.class_name,
          name: args.name,
          include_hidden: args.include_hidden === true,
          limit: clampInt(args.limit, 1, 500, 100),
        },
        ctx,
      ),
  },
  {
    name: "get_script_source",
    title: "Read a script's source",
    description:
      "Read the source code of a Script, LocalScript or ModuleScript by dotted path. It uses the executor's decompile when available and falls back to the Source property. Decompiled sources are cached in the executor (fromCache in the result, refresh decompiles again). Long sources are cut at max_chars. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Dotted path to the script, starting at game." },
        max_chars: {
          type: "integer",
          minimum: 100,
          maximum: 40000,
          description: "Maximum number of characters to return (default 20000).",
        },
        refresh: { type: "boolean", description: "Decompile again instead of using the cached source (default false)." },
        client: CLIENT_PROPERTY,
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) =>
      runSnippet(
        "get_script_source",
        {
          path: requirePath(args),
          max_chars: clampInt(args.max_chars, 100, 40000, 20000),
          refresh: args.refresh === true,
        },
        // Decompiling through an online service can be slow.
        { ...ctx, timeoutMs: 40000 },
      ),
  },
  {
    name: "search_scripts",
    title: "Search inside scripts",
    description:
      "Search the source code of the game's scripts, like grep. Modes: text (exact text, default), pattern (a Lua pattern, always case sensitive) and words (every word must appear, scripts are ranked by how often they match). It decompiles the scripts, which can be slow (results are cached in the executor, set refresh to decompile again), so it stops after budget_seconds and reports how many scripts it searched. Narrow it with root or class_name for speed. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        mode: { type: "string", enum: ["text", "pattern", "words"], description: "How to match the query (default text)." },
        case_sensitive: { type: "boolean", description: "Match the case exactly (default false)." },
        root: { type: "string", description: "Dotted path to search under (default game)." },
        class_name: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], description: "Only search this kind of script." },
        include_hidden: { type: "boolean", description: "Also search scripts outside the tree (default false)." },
        context_lines: { type: "integer", minimum: 0, maximum: 3, description: "Lines of context around each match (default 0)." },
        max_matches: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches to return (default 40)." },
        max_scripts: { type: "integer", minimum: 1, maximum: 500, description: "Maximum number of scripts to search (default 150)." },
        budget_seconds: { type: "integer", minimum: 2, maximum: 60, description: "Stop searching after this many seconds (default 20)." },
        refresh: { type: "boolean", description: "Decompile the scripts again instead of using cached sources (default false)." },
        client: CLIENT_PROPERTY,
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) => {
      if (typeof args.query !== "string" || args.query.length === 0) {
        throw new Error("'query' must be a non-empty string.");
      }
      const budget = clampInt(args.budget_seconds, 2, 60, 20);
      return runSnippet(
        "search_scripts",
        {
          query: args.query,
          mode: args.mode,
          case_sensitive: args.case_sensitive === true,
          root: args.root,
          class_name: args.class_name,
          include_hidden: args.include_hidden === true,
          context_lines: clampInt(args.context_lines, 0, 3, 0),
          max_matches: clampInt(args.max_matches, 1, 200, 40),
          max_scripts: clampInt(args.max_scripts, 1, 500, 150),
          budget_seconds: budget,
          refresh: args.refresh === true,
        },
        { ...ctx, timeoutMs: (budget + 10) * 1000 },
      );
    },
  },
  {
    name: "semantic_search",
    title: "Search scripts by meaning",
    description:
      "Find code by what it does, not by exact words, with embeddings from a local Ollama (model embeddinggemma by default; nothing leaves the computer). Actions: index (read the scripts of the connected game and build the index; big games take several calls, repeat with offset set to the returned nextOffset until done is true), search (query, optional k, path_contains, place_id: returns the closest code chunks with their path and lines), status (what is indexed) and clear (delete the index of place_id, or all). Search and status do not need the game. Needs Ollama running with the model pulled (ollama pull embeddinggemma). For exact text use search_scripts instead.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["index", "search", "status", "clear"], description: "What to do." },
        query: { type: "string", description: "search: what the code should do, in plain words." },
        k: { type: "integer", minimum: 1, maximum: 30, description: "search: how many chunks to return (default 8)." },
        path_contains: { type: "string", description: "search: only chunks whose script path contains this." },
        place_id: { type: "string", description: "search, status, clear: the place to use (default: the most recently indexed one; clear without it deletes every index)." },
        offset: { type: "integer", minimum: 0, description: "index: script to continue from (default 0, which starts a new index)." },
        max_scripts: { type: "integer", minimum: 1, maximum: 3000, description: "index: scripts to process in this call (default 400)." },
        budget_seconds: { type: "integer", minimum: 10, maximum: 300, description: "index: stop after this many seconds (default 100)." },
        root: { type: "string", description: "index: dotted path to index under (default game)." },
        class_name: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], description: "index: only this kind of script." },
        include_hidden: { type: "boolean", description: "index: also scripts outside the tree (default false)." },
        client: CLIENT_PROPERTY,
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    needsRoblox: (args) => args.action === "index",
    local: (args) => args.action !== "index",
    run: async (args, ctx) => {
      if (!["index", "search", "status", "clear"].includes(args.action)) {
        throw new Error("'action' must be index, search, status or clear.");
      }
      try {
        return await semanticAction(args, ctx);
      } catch (error) {
        if (error instanceof semantic.SemanticError) return { ok: false, value: null, error: error.message };
        throw error;
      }
    },
  },
  {
    name: "remote_spy",
    title: "Spy on remote calls",
    description:
      "Record the RemoteEvent:FireServer and RemoteFunction:InvokeServer calls the game's own scripts make, with their arguments and the calling script. Actions: start (begin recording, optional only, ignore, max_calls, include_own), get (read recorded calls, optional since_id, contains, remote, limit), stop, clear and status. Typical use: start, make the action happen (ask the user or use gui_interact), then get. block (remotes: names or full paths) drops the game's calls to those remotes before they reach the server, even without recording, and unblock releases them (all when remotes is empty). Blocking changes how the game behaves, so only do it when the user asked for it and tell them which remotes are blocked. Recording and blocking need hookmetamethod in the executor and stay installed until the game is left. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "get", "clear", "status", "block", "unblock"], description: "What to do." },
        remotes: { type: "array", items: { type: "string" }, description: "block or unblock: remote names or full paths (for example ReplicatedStorage.Events.Buy)." },
        only: { type: "string", description: "start: only record remotes whose name contains this." },
        ignore: { type: "array", items: { type: "string" }, description: "start: remote names to skip, for example noisy ones." },
        max_calls: { type: "integer", minimum: 50, maximum: 2000, description: "start: how many calls to keep (default 500)." },
        include_own: { type: "boolean", description: "start: also record calls made by code run through Superbase. block: also block those calls (default false)." },
        since_id: { type: "integer", description: "get: only calls after this id (use the lastId of the previous result)." },
        contains: { type: "string", description: "get: only calls whose remote name or arguments contain this." },
        remote: { type: "string", description: "get: only calls to the remote with exactly this name." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "get: maximum calls to return, newest kept (default 50)." },
        client: CLIENT_PROPERTY,
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    writes: (args) => args.action === "block" || args.action === "unblock",
    needsRoblox: true,
    run: (args, ctx) => {
      if (!["start", "stop", "get", "clear", "status", "block", "unblock"].includes(args.action)) {
        throw new Error("'action' must be start, stop, get, clear, status, block or unblock.");
      }
      if (args.action === "block" && !(Array.isArray(args.remotes) && args.remotes.length > 0)) {
        throw new Error("'remotes' is required for block: the names or full paths of the remotes to block.");
      }
      return runSnippet(
        "remote_spy",
        {
          action: args.action,
          only: args.only,
          ignore: Array.isArray(args.ignore) ? args.ignore.map(String) : undefined,
          remotes: Array.isArray(args.remotes) ? args.remotes.map(String) : undefined,
          max_calls: args.max_calls === undefined ? undefined : clampInt(args.max_calls, 50, 2000, 500),
          include_own: args.include_own === true,
          since_id: args.since_id,
          contains: args.contains,
          remote: args.remote,
          limit: args.limit === undefined ? undefined : clampInt(args.limit, 1, 200, 50),
        },
        ctx,
      );
    },
  },
  {
    name: "inspect_code",
    title: "Inspect running code",
    description:
      "Look inside code that is running in the game, for reverse engineering. Actions: upvalues and constants (path of a script; for a ModuleScript also function_name to look at one function of the module), gc (search the garbage collector for functions by name_contains or has_constant, or for tables by has_key; at least one filter is required) and connections (path of an instance and the name of one of its signals: lists the handlers that are connected, with the function name, line, source and owning script). Needs the matching executor functions (getscriptclosure, getupvalues, getconstants, getgc, getconnections) and says which one is missing. Only reads. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["upvalues", "constants", "gc", "connections"], description: "What to inspect." },
        path: { type: "string", description: "upvalues, constants: dotted path of the script. connections: dotted path of the instance." },
        function_name: { type: "string", description: "upvalues, constants: a function of the ModuleScript's returned table, instead of the main chunk." },
        signal: { type: "string", description: "connections: the event name, for example MouseButton1Click or Touched." },
        kind: { type: "string", enum: ["function", "table"], description: "gc: what to search for (default function)." },
        name_contains: { type: "string", description: "gc, functions: the function name contains this." },
        has_constant: { type: "string", description: "gc, functions: the function uses this string constant." },
        has_key: { type: "string", description: "gc, tables: the table has this string key." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum entries to return (default 40 for upvalues and constants, 25 otherwise)." },
        client: CLIENT_PROPERTY,
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) => {
      if (!["upvalues", "constants", "gc", "connections"].includes(args.action)) {
        throw new Error("'action' must be upvalues, constants, gc or connections.");
      }
      if (["upvalues", "constants", "connections"].includes(args.action)) requirePath(args);
      return runSnippet(
        "inspect_code",
        {
          action: args.action,
          path: args.path,
          function_name: args.function_name,
          signal: args.signal,
          kind: args.kind,
          name_contains: args.name_contains,
          has_constant: args.has_constant,
          has_key: args.has_key,
          limit: args.limit === undefined ? undefined : clampInt(args.limit, 1, 100, 25),
        },
        // Walking the whole heap can take a while in a big game.
        { ...ctx, timeoutMs: 40000 },
      );
    },
  },
  {
    name: "call_instance",
    title: "Call a method, remote or signal",
    description:
      "Act on the running game directly. Actions: method (call a method of the instance at path, for example FindFirstChild or Destroy, with args), fire_remote (RemoteEvent:FireServer or RemoteFunction:InvokeServer with args, returns the answer of an InvokeServer) and fire_signal (firesignal on one of its events, for example MouseButton1Click). Roblox values in args are written as objects with __type: {\"__type\":\"Vector3\",\"x\":1,\"y\":2,\"z\":3}, Vector2, Color3 (r, g, b from 0 to 255), CFrame (x, y, z), Enum ({\"__type\":\"Enum\",\"value\":\"Enum.Material.Neon\"}) and Instance ({\"__type\":\"Instance\",\"path\":\"game.Workspace.Part\"}). This changes the running game and can have effects on the server, so only do it when the user asked for it. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["method", "fire_remote", "fire_signal"], description: "What to do." },
        path: { type: "string", description: "Dotted path of the instance, starting at game." },
        method: { type: "string", description: "method: the method name." },
        signal: { type: "string", description: "fire_signal: the event name." },
        args: { type: "array", items: {}, description: "Arguments, in order. Use __type objects for Roblox values (see the tool description). null is not supported." },
        client: CLIENT_PROPERTY,
      },
      required: ["action", "path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    writes: true,
    needsRoblox: true,
    run: (args, ctx) => {
      if (!["method", "fire_remote", "fire_signal"].includes(args.action)) {
        throw new Error("'action' must be method, fire_remote or fire_signal.");
      }
      requirePath(args);
      if (args.action === "method" && !(typeof args.method === "string" && args.method.length > 0)) {
        throw new Error("'method' is required for the method action.");
      }
      if (args.action === "fire_signal" && !(typeof args.signal === "string" && args.signal.length > 0)) {
        throw new Error("'signal' is required for the fire_signal action.");
      }
      if (args.args !== undefined && !Array.isArray(args.args)) {
        throw new Error("'args' must be a list.");
      }
      if (Array.isArray(args.args) && args.args.some((value) => value === null)) {
        throw new Error("null is not supported in args, because it would shift the other arguments.");
      }
      return runSnippet(
        "call_instance",
        { action: args.action, path: args.path, method: args.method, signal: args.signal, args: args.args },
        // InvokeServer waits for the server.
        { ...ctx, timeoutMs: 30000 },
      );
    },
  },
  {
    name: "wait_for_instance",
    title: "Wait for an instance",
    description:
      "Wait until the instance at a dotted path exists (and optionally is of a class), for example after a teleport or while a map loads. Returns found true with the path, or found false with the segment that is still missing after the timeout. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Dotted path, starting at game." },
        timeout: { type: "number", minimum: 0.5, maximum: 60, description: "Seconds to wait (default 10)." },
        class_name: { type: "string", description: "The instance must be of this class (IsA)." },
        client: CLIENT_PROPERTY,
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) => {
      requirePath(args);
      const timeout = Math.min(60, Math.max(0.5, Number.isFinite(Number(args.timeout)) ? Number(args.timeout) : 10));
      return runSnippet(
        "wait_for_instance",
        { path: args.path, timeout, class_name: args.class_name },
        { ...ctx, timeoutMs: Math.ceil(timeout + 10) * 1000 },
      );
    },
  },
  {
    name: "http_spy",
    title: "Spy on HTTP requests",
    description:
      "Record the HTTP requests that scripts send: the executor's request functions (request, http_request, syn.request, ...) and game:HttpGet, HttpPost and HttpService calls. Each entry has the method, address, headers, body, status and answer. It sees the requests of the game and of any other script in the executor, but not the traffic between Superbase and its bridge. Authorization, cookie and token values (also in addresses) and the Roblox account cookie are replaced with <redacted> before they are stored, and bodies are cut at max_body. Actions: start (optional max_calls, max_body, include_bodies, url_contains), get (optional since_id, url_contains, method, limit), stop, clear and status. Typical use: start, make the action happen, then get. Needs hookfunction or hookmetamethod in the executor and stays installed until the game is left. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "get", "clear", "status"], description: "What to do." },
        max_calls: { type: "integer", minimum: 20, maximum: 1000, description: "start: how many requests to keep (default 200)." },
        max_body: { type: "integer", minimum: 0, maximum: 4000, description: "start: characters kept of each body (default 500)." },
        include_bodies: { type: "boolean", description: "start: keep request and response bodies (default true)." },
        url_contains: { type: "string", description: "start: only record addresses that contain this. get: only return those." },
        since_id: { type: "integer", description: "get: only requests after this id (use the lastId of the previous result)." },
        method: { type: "string", description: "get: only this HTTP method, for example POST." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "get: maximum requests to return, newest kept (default 30)." },
        client: CLIENT_PROPERTY,
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    needsRoblox: true,
    run: (args, ctx) => {
      if (!["start", "stop", "get", "clear", "status"].includes(args.action)) {
        throw new Error("'action' must be start, stop, get, clear or status.");
      }
      return runSnippet(
        "http_spy",
        {
          action: args.action,
          max_calls: args.max_calls === undefined ? undefined : clampInt(args.max_calls, 20, 1000, 200),
          max_body: args.max_body === undefined ? undefined : clampInt(args.max_body, 0, 4000, 500),
          include_bodies: args.include_bodies,
          url_contains: args.url_contains,
          since_id: args.since_id,
          method: args.method,
          limit: args.limit === undefined ? undefined : clampInt(args.limit, 1, 100, 30),
        },
        ctx,
      );
    },
  },
  {
    name: "notify",
    title: "Show a toast in the game",
    description:
      "Show a small notification (toast) in the corner of the Roblox window, for example to tell the user that a long task is done while they are playing. Keep it short. Needs a Superbase client from version 1.4.0 and notifications switched on in the client settings. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title (at most 80 characters)." },
        text: { type: "string", description: "Optional message (at most 300 characters)." },
        kind: { type: "string", enum: ["info", "success", "warning", "error"], description: "Look of the toast (default info)." },
        client: CLIENT_PROPERTY,
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    needsRoblox: true,
    run: (args, ctx) => {
      if (typeof args.title !== "string" || args.title.length === 0) {
        throw new Error("'title' must be a non-empty string.");
      }
      return runSnippet("notify", { title: args.title, text: args.text, kind: args.kind }, ctx);
    },
  },
  {
    name: "run_file",
    title: "Run a Lua file from disk",
    description:
      "Read a .lua, .luau or .txt file from this computer and run it in the connected Roblox executor, like execute_lua but without pasting the code. The path is on the computer that runs the Superbase MCP server (absolute, or relative to its working folder; ~ is the home folder). Files up to 500 KB. The code runs with the executor's full permissions, so only run files the user asked for. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file on this computer." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, description: "How long to wait for the code to finish (default 15000)." },
        client: CLIENT_PROPERTY,
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    writes: true,
    needsRoblox: true,
    run: async (args, ctx) => {
      const file = readLuaFile(requirePath(args));
      const result = await execOnClient(file.source, {
        client: ctx.client,
        timeoutMs: args.timeout_ms === undefined ? undefined : clampInt(args.timeout_ms, 1000, 120000, 15000),
      });
      return { ...result, file: file.path, bytes: file.bytes };
    },
  },
  {
    name: "gui_interact",
    title: "Operate the game's GUI",
    description:
      "Look at and operate the game's interface. Actions: list (buttons and text boxes with text, visibility and position; default root is the player's PlayerGui), click (press a button: its own events by default, or a real mouse click with mode mouse), set_text (fill a text box, optionally press Enter with submit) and trigger (fire a ClickDetector or ProximityPrompt, given directly or found inside the part or model). Changes the running game. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "click", "set_text", "trigger"], description: "What to do." },
        path: { type: "string", description: "click, set_text, trigger: dotted path of the target." },
        root: { type: "string", description: "list: dotted path to search under (default the player's PlayerGui)." },
        kind: { type: "string", enum: ["buttons", "inputs", "all"], description: "list: what to list (default all)." },
        visible_only: { type: "boolean", description: "list: skip hidden elements (default true)." },
        text: { type: "string", description: "list: only elements whose text or name contains this. set_text: the text to enter." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "list: maximum elements (default 60)." },
        mode: { type: "string", enum: ["auto", "signal", "mouse"], description: "click: auto (events first, then mouse), signal or mouse." },
        submit: { type: "boolean", description: "set_text: also press Enter (default false)." },
        client: CLIENT_PROPERTY,
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    writes: (args) => args.action !== "list",
    needsRoblox: true,
    run: (args, ctx) => {
      if (!["list", "click", "set_text", "trigger"].includes(args.action)) {
        throw new Error("'action' must be list, click, set_text or trigger.");
      }
      if (args.action !== "list") requirePath(args);
      if (args.action === "set_text" && typeof args.text !== "string") {
        throw new Error("'text' is required for set_text.");
      }
      return runSnippet(
        "gui_interact",
        {
          action: args.action,
          path: args.path,
          root: args.root,
          kind: args.kind,
          visible_only: args.visible_only,
          text: args.text,
          limit: args.limit === undefined ? undefined : clampInt(args.limit, 1, 200, 60),
          mode: args.mode,
          submit: args.submit === true,
        },
        ctx,
      );
    },
  },
  {
    name: "screenshot",
    title: "Screenshot the Roblox window",
    description:
      "Take a screenshot of the Roblox window and return it as an image, so you can see what the player sees. It captures the real window on the computer where the bridge runs (Windows only), so the window must be visible: not minimized and not covered by another window. It asks Windows to draw the Roblox window itself, so other windows in front of it do not end up in the picture and nothing is raised. If that gives no usable picture, it falls back to copying the screen area of the window: with focus true (default) Roblox is raised for a moment and your previous window is put back, with focus false the screen is copied as it is. Does not need the executor connection.",
    inputSchema: {
      type: "object",
      properties: {
        max_width: { type: "integer", minimum: 320, maximum: 1920, description: "Scale the image down to this width (default 1280, or screenshotMaxWidth from the config)." },
        focus: { type: "boolean", description: "Allow the fallback to raise the Roblox window for a moment and put the previous window back (default true, or screenshotFocus from the config). Set false to never touch the windows." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: async (args) => {
      const query = new URLSearchParams();
      query.set("max_width", String(clampInt(args.max_width, 320, 1920, SETTINGS.screenshotMaxWidth)));
      const focus = typeof args.focus === "boolean" ? args.focus : SETTINGS.screenshotFocus;
      if (focus) query.set("focus", "1");
      const suffix = query.toString();
      const shot = await bridgeRequest("GET", `/screenshot${suffix ? `?${suffix}` : ""}`, undefined, SCREENSHOT_TIMEOUT_MS);
      return { image: { data: shot.data, mimeType: shot.mimeType }, width: shot.width, height: shot.height, title: shot.title, ...(shot.method ? { method: shot.method } : {}) };
    },
  },
  {
    name: "set_property",
    title: "Set a property",
    description:
      'Set a property on an instance in the running game (on the client, so it only replicates where Roblox allows it). The value is given as JSON text in value_json: a string, number or boolean (for example "42" or "\\"Hello\\""), or an object with a type field: {"type":"Vector3","x":1,"y":2,"z":3}, {"type":"Vector2","x":1,"y":2}, {"type":"Color3","r":255,"g":0,"b":0}, {"type":"Enum","enum":"Material","name":"Neon"} or {"type":"Instance","path":"game.Workspace.Part"}. Returns the old and new value. Requires the connected state.',
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Dotted path to the instance, starting at game." },
        property: { type: "string", description: "Property name, for example Transparency." },
        value_json: { type: "string", description: "The new value as JSON text (see the tool description)." },
        client: CLIENT_PROPERTY,
      },
      required: ["path", "property", "value_json"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    writes: true,
    needsRoblox: true,
    run: (args, ctx) => {
      requirePath(args);
      if (typeof args.property !== "string" || args.property.length === 0) {
        throw new Error("'property' must be a non-empty string.");
      }

      let value;
      try {
        value = JSON.parse(args.value_json);
      } catch {
        throw new Error("'value_json' must be valid JSON text.");
      }
      if (value === null) {
        throw new Error("'value_json' cannot be null. Use execute_lua to set a property to nil.");
      }
      return runSnippet("set_property", { path: args.path, property: args.property, value }, ctx);
    },
  },
  {
    name: "player_info",
    title: "Players and characters",
    description:
      "Look at the players in the server. action list (default) returns every player with team, character position, distance to the local player and health; details true adds walk speed, jump, state, equipped tools, backpack, leaderstats and attributes. action character returns all of that for one player (player: name, display name or user id; default the local player). Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "character"], description: "list (default) or character." },
        player: { type: "string", description: "character: name, display name or user id (a part of the name is enough). Default: the local player." },
        details: { type: "boolean", description: "list: include speed, tools, leaderstats and attributes (default false)." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "list: maximum number of players (default 50)." },
        client: CLIENT_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) => {
      const action = args.action === undefined ? "list" : args.action;
      if (action !== "list" && action !== "character") throw new Error("'action' must be list or character.");
      return runSnippet(
        "player_info",
        {
          action,
          player: args.player === undefined || args.player === null ? "" : String(args.player),
          details: args.details === true,
          limit: clampInt(args.limit, 1, 100, 50),
        },
        ctx,
      );
    },
  },
  {
    name: "character_control",
    title: "Move the local character",
    description:
      "Move the local player's character. action teleport puts it at the target at once; action walk_to makes it walk there with the humanoid (it stops when it arrives, gets stuck or the timeout passes). The target is one of: position ({x,y,z}), player (another player's name, display name or user id) or path (a dotted path to a part or model). Near a player or instance the character lands offset_y studs above it (default 3). Teleporting can trigger anti-cheat in some games, so only do it when the user asked. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["teleport", "walk_to"], description: "teleport or walk_to." },
        position: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
          required: ["x", "y", "z"],
          additionalProperties: false,
          description: "World position to go to.",
        },
        player: { type: "string", description: "Go to this other player." },
        path: { type: "string", description: "Go to this part or model (dotted path starting at game)." },
        offset_y: { type: "number", description: "Studs above the player or instance (default 3)." },
        timeout: { type: "number", minimum: 1, maximum: 30, description: "walk_to: seconds to wait for the character to arrive (default 10)." },
        client: CLIENT_PROPERTY,
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    writes: true,
    needsRoblox: true,
    run: (args, ctx) => {
      if (args.action !== "teleport" && args.action !== "walk_to") throw new Error("'action' must be teleport or walk_to.");
      const timeout = clampInt(args.timeout, 1, 30, 10);
      const snippetArgs = { action: args.action, timeout };
      if (args.position && typeof args.position === "object") snippetArgs.position = args.position;
      if (typeof args.player === "string" && args.player !== "") snippetArgs.player = args.player;
      if (typeof args.path === "string" && args.path !== "") snippetArgs.path = args.path;
      if (args.offset_y !== undefined) snippetArgs.offset_y = Number(args.offset_y);
      return runSnippet("character_control", snippetArgs, { ...ctx, timeoutMs: args.action === "walk_to" ? (timeout + 5) * 1000 : undefined });
    },
  },
  {
    name: "stats",
    title: "Performance stats",
    description:
      "Measure how the game performs right now: it samples the frames for a moment (average FPS, minimum FPS, the 1% low, frame time, stutters longer than 50 ms), and reports physics FPS, memory, ping, network traffic, instance and part counts, plus short notes that say what looks wrong. memory detail adds the memory per category. The game window must be visible, because Roblox does not render frames for a minimized window. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        sample_seconds: { type: "number", minimum: 0.5, maximum: 5, description: "How long to measure frames (default 1.5)." },
        memory: { type: "string", enum: ["summary", "detail"], description: "detail adds the memory per category (default summary)." },
        client: CLIENT_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    needsRoblox: true,
    run: (args, ctx) => {
      const seconds = Math.min(5, Math.max(0.5, Number.isFinite(Number(args.sample_seconds)) ? Number(args.sample_seconds) : 1.5));
      const memory = args.memory === "detail" ? "detail" : "summary";
      return runSnippet("stats", { sample_seconds: seconds, memory }, { ...ctx, timeoutMs: Math.round(seconds * 1000) + 10000 });
    },
  },
  {
    name: "snapshot",
    title: "Snapshot and diff",
    description:
      "Save the state of part of the game and later see exactly what changed. action take records the instances under a path (names, classes and the properties that matter for each class, or the ones you list) in a named slot; action diff compares the slot with the game as it is now and lists what was added, removed and changed (property, before, after); action list shows the slots; action delete removes one. Use it around an action: take, let the user do something or trigger it with gui_interact, then diff. Snapshots live in the executor's memory, at most 10 slots, and are gone when the game is left. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["take", "diff", "list", "delete"], description: "take (default), diff, list or delete." },
        name: { type: "string", description: "Slot name (default 'default')." },
        path: { type: "string", description: "take: dotted path of the root (default game.Workspace)." },
        depth: { type: "integer", minimum: 1, maximum: 10, description: "take: how many levels below the root to record (default 4)." },
        properties: { type: "array", items: { type: "string" }, description: "take: property names to record for every instance. Default: a sensible set for each class (Position, Size, Anchored, Text, Value, Health and so on)." },
        max_instances: { type: "integer", minimum: 1, maximum: 5000, description: "take: stop after this many instances (default 1500)." },
        keep: { type: "boolean", description: "diff: replace the saved slot with the current state afterwards, so the next diff starts from here." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "diff: entries per list (default 50)." },
        client: CLIENT_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    needsRoblox: true,
    run: (args, ctx) => {
      const action = args.action === undefined ? "take" : args.action;
      if (!["take", "diff", "list", "delete"].includes(action)) throw new Error("'action' must be take, diff, list or delete.");
      const snippetArgs = { action, limit: clampInt(args.limit, 1, 200, 50), keep: args.keep === true };
      if (typeof args.name === "string" && args.name !== "") snippetArgs.name = args.name;
      if (typeof args.path === "string" && args.path !== "") snippetArgs.path = args.path;
      if (args.depth !== undefined) snippetArgs.depth = clampInt(args.depth, 1, 10, 4);
      if (Array.isArray(args.properties)) snippetArgs.properties = args.properties.filter((item) => typeof item === "string" && item !== "").slice(0, 40);
      if (args.max_instances !== undefined) snippetArgs.max_instances = clampInt(args.max_instances, 1, 5000, 1500);
      return runSnippet("snapshot", snippetArgs, { ...ctx, timeoutMs: 30000 });
    },
  },
  {
    name: "recipes",
    title: "Recipes (saved Lua scripts)",
    description:
      "Reusable Lua scripts kept as .lua files in the recipes folder of Superbase (the user can also run them from the dashboard). action list shows the recipes with their description and arguments; action run executes one in the game (name, and args for the recipe, available there as the table args); action save writes a new recipe (name, code, and a title, description and usage line for its header; overwrite true replaces an existing one). Recipe names are lowercase letters, digits, - and _. Recipes run with the executor's full permissions like execute_lua, so read a recipe's code before you run one you did not write. Sharing: preview_import downloads a recipe from a link (https only; GitHub files and gists, GitLab files; at most 100 KB) and shows its code and header without saving anything. Show that code to the user and say what it does. import saves it into the recipes folder, and only with confirm true after the user has agreed; it never runs the recipe. Imported code comes from the internet and is untrusted. run needs the connected state, the other actions do not.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "run", "save", "preview_import", "import"], description: "list (default), run, save, preview_import or import." },
        name: { type: "string", description: "run, save, import: the recipe name, for example list-remotes. import: defaults to the name of the file in the link." },
        url: { type: "string", description: "preview_import, import: https link to a .lua file on GitHub, a GitHub gist or GitLab." },
        confirm: { type: "boolean", description: "import: must be true. Set it only after the user has seen the code from preview_import and agreed." },
        args: { type: "object", description: "run: arguments for the recipe, available in Lua as the table args.", additionalProperties: true },
        code: { type: "string", description: "save: the Lua code of the recipe. It can use args and should return a value." },
        title: { type: "string", description: "save: short title for the header." },
        description: { type: "string", description: "save: one line that says what the recipe does." },
        usage: { type: "string", description: "save: one line that describes the args it takes, for example 'contains (string, optional)'." },
        overwrite: { type: "boolean", description: "save, import: replace a recipe that already exists (default false)." },
        client: CLIENT_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    writes: (args) => ["run", "save", "import"].includes(args.action),
    needsRoblox: (args) => args.action === "run",
    // Listing and saving only touch the recipes folder, so they work without the bridge.
    local: (args) => args.action !== "run",
    run: async (args, ctx) => {
      const action = args.action === undefined ? "list" : args.action;
      try {
        if (action === "list") {
          return { dir: RECIPES_DIR, recipes: recipeStore.list(RECIPES_DIR) };
        }
        if (action === "run") {
          const recipe = recipeStore.read(RECIPES_DIR, String(args.name || ""));
          const recipeArgs = args.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {};
          return await runLua(recipe.source, recipeArgs, { ...ctx, timeoutMs: 30000 });
        }
        if (action === "preview_import") {
          const fetched = await recipeImport.fetchRecipe(String(args.url || ""));
          const header = recipeStore.parseHeader(fetched.source);
          // Inside value, so the code is shown as a block of Lua instead of an escaped string.
          return {
            ok: true,
            value: {
              url: fetched.url,
              bytes: fetched.bytes,
              suggestedName: fetched.suggestedName,
              title: header.title,
              description: header.description,
              args: header.args,
              note: "Nothing was saved. Show this code to the user. To keep it, call import with the same url and confirm true.",
              source: fetched.source,
            },
          };
        }
        if (action === "import") {
          if (args.confirm !== true) {
            return { ok: false, value: null, error: "import needs confirm true, set only after the user has seen the code (preview_import) and agreed to save it." };
          }
          const fetched = await recipeImport.fetchRecipe(String(args.url || ""));
          const name = args.name === undefined ? fetched.suggestedName : String(args.name);
          const result = recipeStore.save(RECIPES_DIR, name, `-- Source: ${fetched.url}\n${fetched.source}`, {
            title: args.title || name,
            description: args.description || `Imported from ${fetched.url}`,
            args: args.usage,
            overwrite: args.overwrite === true,
          });
          return { ...result, url: fetched.url, bytes: fetched.bytes, note: "Saved, not run. Read the code before you run it." };
        }
        if (action === "save") {
          return recipeStore.save(RECIPES_DIR, String(args.name || ""), args.code, {
            title: args.title,
            description: args.description,
            args: args.usage,
            overwrite: args.overwrite === true,
          });
        }
      } catch (error) {
        if (error instanceof recipeStore.RecipeError || error instanceof recipeImport.ImportError) return { ok: false, value: null, error: error.message };
        throw error;
      }
      throw new Error("'action' must be list, run, save, preview_import or import.");
    },
  },
  {
    name: "clear_logs",
    title: "Clear stored logs",
    description:
      "Permanently delete the console logs and script errors that the bridge has stored, for all clients or only for one. " +
      "The bridge keeps them in memory only, so a cleared entry cannot be recovered. Nothing else is touched: the Roblox " +
      "console, snapshots, recipes and the game itself stay as they are. " +
      "Use it to get a clean slate right before you reproduce a problem, so that get_logs, get_errors and wait_for_log only " +
      "show new lines. Do not use it to hide old output you may still need: read it with get_logs or get_errors first. " +
      "It does not need a running game, and clearing an empty store is harmless. Returns { cleared: true, client } where client is null when everything was cleared.",
    inputSchema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          description: "Only delete the entries of this client id, as listed by list_clients. Default: delete the entries of all clients.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (args) => bridgeRequest("POST", "/clear", args.client ? { client: String(args.client) } : {}),
  },
];

// Long text fields read much better as plain text than as an escaped JSON string.
function splitLongText(data) {
  const value = data && typeof data === "object" && data.value && typeof data.value === "object" ? data.value : null;
  for (const field of ["tree", "source"]) {
    if (value && typeof value[field] === "string") {
      const { [field]: text, ...rest } = value;
      return { data: { ...data, value: rest }, text, label: field };
    }
  }
  return { data, text: null, label: null };
}

function formatResult(header, data, isError) {
  const split = splitLongText(data);
  let body = JSON.stringify(split.data, null, 2);
  let text = split.text;

  if (text !== null) {
    const budget = Math.max(2000, MAX_OUTPUT_CHARS - body.length);
    if (text.length > budget) text = `${text.slice(0, budget)}\n... [truncated]`;
    const fence = split.label === "source" ? "```lua\n" : "```\n";
    body = `${body}\n\n${fence}${text}\n\`\`\``;
  } else if (body.length > MAX_OUTPUT_CHARS) {
    body = `${body.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated]`;
  }
  return { content: [{ type: "text", text: `${header}\n\n${body}` }], isError };
}

function formatImage(header, data) {
  const { image, ...meta } = data;
  return {
    content: [
      { type: "text", text: `${header}\n\n${JSON.stringify(meta, null, 2)}` },
      { type: "image", data: image.data, mimeType: image.mimeType },
    ],
    isError: false,
  };
}

// One-time notes for the status line: the bridge was started automatically, a new release exists.
let updateNoticeFor = null;
let safeModeAnnounced = false;
function pendingNotes(connection) {
  const notes = [];
  if (SETTINGS.readOnly && !safeModeAnnounced) {
    safeModeAnnounced = true;
    notes.push("[Superbase] Safe mode is on: tools that change the game or run code are turned off.");
  }
  if (autostart.notice) {
    notes.push(autostart.notice);
    autostart.notice = null;
  }
  const update = connection.update;
  if (update && update.available && update.latest && updateNoticeFor !== update.latest) {
    updateNoticeFor = update.latest;
    notes.push(`[Superbase] Version ${update.latest} is available (this is ${VERSION}). The user can update with npm run update in the Superbase folder.`);
  }
  return notes;
}

// Safe mode (the readOnly setting): tools that change the game, run code or write files are turned off. A tool that
// can both read and write has a function in `writes` that looks at the arguments.
function writesWith(tool, args) {
  return typeof tool.writes === "function" ? tool.writes(args) === true : tool.writes === true;
}

function safeModeRefusal(tool) {
  return {
    content: [
      {
        type: "text",
        text: `[Superbase] Safe mode is on, so ${tool.name} is turned off for this request. Safe mode lets the AI look at the game but not change it or run code. The user can turn it off with "readOnly": false in superbase.config.json (or SUPERBASE_READ_ONLY=0) and by restarting the AI client.`,
      },
    ],
    isError: true,
  };
}

// Every result starts with a status line, so the AI always knows if Roblox is connected.
async function callTool(tool, args) {
  if (SETTINGS.readOnly && writesWith(tool, args)) return safeModeRefusal(tool);
  if (typeof tool.local === "function" && tool.local(args)) {
    try {
      const data = await tool.run(args, {});
      return formatResult("[Superbase] Local action: the game was not contacted.", data, Boolean(data && data.ok === false));
    } catch (error) {
      return { content: [{ type: "text", text: `[Superbase] Local action: the game was not contacted.\n\n${error.message}` }], isError: true };
    }
  }
  const requestedClient = typeof args.client === "string" && args.client.length > 0 ? args.client : undefined;
  const connection = await assessConnection(tool.probe === true, requestedClient);
  let header = statusLine(connection);
  for (const note of pendingNotes(connection)) header = `${header}\n${note}`;
  const needsRoblox = typeof tool.needsRoblox === "function" ? tool.needsRoblox(args) : tool.needsRoblox === true;

  if (tool.reportsConnection) {
    return formatResult(header, connection, false);
  }

  const bridgeUp = !BRIDGE_DOWN_STATES.has(connection.state);
  if (!bridgeUp || (needsRoblox && connection.state !== "connected")) {
    return { content: [{ type: "text", text: `${header}\n\n${tool.name} was not run.` }], isError: true };
  }

  try {
    // Commands go to the client that was selected when the status was checked.
    const context = { client: needsRoblox ? connection.selectedClient || requestedClient : requestedClient };
    const data = await tool.run(args, context);
    if (data && data.image) {
      return formatImage(header, data);
    }
    return formatResult(header, data, Boolean(data && data.ok === false));
  } catch (error) {
    return { content: [{ type: "text", text: `${header}\n\n${error.message}` }], isError: true };
  }
}

function rpcError(code, message) {
  const error = new Error(message);
  error.rpcCode = code;
  return error;
}

async function handleRequest(message) {
  switch (message.method) {
    case "initialize": {
      const requested = message.params && message.params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: SERVER_INFO,
        instructions: SETTINGS.readOnly
          ? `${INSTRUCTIONS}\n\nSafe mode is ON: tools that change the game or run code (execute_lua, set_property, character_control, call_instance, run_file, recipes run and save, gui_interact click, set_text and trigger, remote_spy block) are turned off. Work with the read-only tools, and tell the user to turn off "readOnly" in superbase.config.json if they need more.`
          : INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        // In safe mode the tools that only write are not offered at all.
        tools: tools
          .filter((tool) => !(SETTINGS.readOnly && tool.writes === true))
          .map(({ run, probe, needsRoblox, reportsConnection, local, writes, ...definition }) => definition),
      };
    case "tools/call": {
      const params = message.params || {};
      const tool = tools.find((candidate) => candidate.name === params.name);
      if (!tool) {
        throw rpcError(-32602, `Unknown tool: ${params.name}`);
      }
      return callTool(tool, params.arguments || {});
    }
    // Some clients ask for these even though they are not advertised.
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: prompts.list() };
    case "prompts/get": {
      const params = message.params || {};
      try {
        return prompts.get(String(params.name || ""), params.arguments);
      } catch (error) {
        if (error instanceof prompts.PromptError) throw rpcError(-32602, error.message);
        throw error;
      }
    }
    default:
      throw rpcError(-32601, `Method not found: ${message.method}`);
  }
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const lines = readline.createInterface({ input: process.stdin });

lines.on("line", async (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  // Notifications (no id) and responses from the client need no reply.
  if (message.id === undefined || message.id === null || typeof message.method !== "string") return;

  try {
    send({ jsonrpc: "2.0", id: message.id, result: await handleRequest(message) });
  } catch (error) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: error.rpcCode || -32603, message: error.message } });
  }
});

lines.on("close", () => process.exit(0));
