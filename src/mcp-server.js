"use strict";

// Superbase MCP server (stdio transport).
// Connects any MCP-capable AI to one or more live Roblox executor sessions through the local
// Superbase bridge (bridge.js). It has no dependencies.
// stdout is reserved for protocol messages; diagnostics must go to stderr.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { parseSelector, SelectorError } = require("./selector");

const VERSION = "1.3.0";
const PORT = Number(process.env.SUPERBASE_PORT || process.env.BRIDGE_PORT || 9731);
const TOKEN = process.env.SUPERBASE_TOKEN || process.env.BRIDGE_TOKEN || "";
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Set this to a public raw URL of roblox/client.lua if you host it somewhere (for example GitHub).
const CLIENT_URL_OVERRIDE = process.env.SUPERBASE_CLIENT_URL || "";
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
  "- States: connected (all tools work); waiting_for_roblox (the bridge runs but no game is connected); unresponsive (a client is connected but does not answer: the game may be frozen, loading or closing); unknown_client (the client id you passed is not connected); bridge_offline (the bridge is not running: ask the user to start it with npm start); token_mismatch (the bridge and this MCP config disagree about the token).",
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
  "- remote_spy records RemoteEvent and RemoteFunction calls: start it, let the user (or gui_interact) trigger the action, read the calls with get, then stop it.",
  "- gui_interact lists buttons and text boxes, clicks buttons, types into text boxes and triggers click detectors and proximity prompts. screenshot shows what the Roblox window looks like (Windows only).",
  "- To check the effect of an action, use execute_lua with capture_logs, or wait_for_log to wait for a specific console line.",
  "- Logs and errors are stored by the bridge, so get_logs and get_errors still work while waiting_for_roblox.",
  "",
  "Selector syntax for find_instances: Type, #Name, [property=value], descendants separated by a space, direct children with >. Examples: RemoteEvent, Model > Part, Part[Anchored=false], TextButton#Play, Frame TextLabel[Text*='coins']. Operators: = != *= (contains) ^= (starts with) $= (ends with) < <= > >=.",
  "",
  "Safety:",
  "- execute_lua, set_property, gui_interact (click, set_text, trigger) and remote_spy change or observe the running game with the executor's full permissions. Only do what the user asked for, and explain anything that changes the game or the user's files before you do it.",
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

function hintFor(state, status) {
  switch (state) {
    case "bridge_offline":
      return `The Superbase bridge is not running on ${BASE_URL}. Ask the user to start it (npm start in the Superbase folder).`;
    case "token_mismatch":
      return TOKEN
        ? "The bridge rejected this server's token. BRIDGE_TOKEN in the MCP config must match the token the bridge was started with."
        : "The bridge requires a token. Set BRIDGE_TOKEN in the MCP config to the token the bridge was started with, or restart the bridge without a token.";
    case "waiting_for_roblox": {
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

// Works out what the AI can do right now. With probe, the bridge pings the Roblox client.
// With a client id, the answer is about that client.
async function assessConnection(probe, client) {
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
    return { state, ready: false, hint: hintFor(state) || error.message };
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
    return `[Superbase] ● connected${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`;
  }
  return `[Superbase] ○ ${connection.state} — ${connection.hint}`;
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
async function runSnippet(name, args, { client, timeoutMs } = {}) {
  const code = `local args = game:GetService("HttpService"):JSONDecode(${luaString(JSON.stringify(args))})\n${loadSnippet(name)}`;
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
      "Read the source code of a Script, LocalScript or ModuleScript by dotted path. It uses the executor's decompile when available and falls back to the Source property. Long sources are cut at max_chars. Requires the connected state.",
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
        },
        // Decompiling through an online service can be slow.
        { ...ctx, timeoutMs: 40000 },
      ),
  },
  {
    name: "search_scripts",
    title: "Search inside scripts",
    description:
      "Search the source code of the game's scripts, like grep. Modes: text (exact text, default), pattern (a Lua pattern, always case sensitive) and words (every word must appear, scripts are ranked by how often they match). It decompiles the scripts, which can be slow, so it stops after budget_seconds and reports how many scripts it searched. Narrow it with root or class_name for speed. Requires the connected state.",
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
        },
        { ...ctx, timeoutMs: (budget + 10) * 1000 },
      );
    },
  },
  {
    name: "remote_spy",
    title: "Spy on remote calls",
    description:
      "Record the RemoteEvent:FireServer and RemoteFunction:InvokeServer calls the game's own scripts make, with their arguments and the calling script. Actions: start (begin recording, optional only, ignore, max_calls, include_own), get (read recorded calls, optional since_id, contains, remote, limit), stop, clear and status. Typical use: start, make the action happen (ask the user or use gui_interact), then get. Recording needs hookmetamethod in the executor and stays installed until the game is left. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "get", "clear", "status"], description: "What to do." },
        only: { type: "string", description: "start: only record remotes whose name contains this." },
        ignore: { type: "array", items: { type: "string" }, description: "start: remote names to skip, for example noisy ones." },
        max_calls: { type: "integer", minimum: 50, maximum: 2000, description: "start: how many calls to keep (default 500)." },
        include_own: { type: "boolean", description: "start: also record calls made by code run through Superbase (default false)." },
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
    needsRoblox: true,
    run: (args, ctx) => {
      if (!["start", "stop", "get", "clear", "status"].includes(args.action)) {
        throw new Error("'action' must be start, stop, get, clear or status.");
      }
      return runSnippet(
        "remote_spy",
        {
          action: args.action,
          only: args.only,
          ignore: Array.isArray(args.ignore) ? args.ignore.map(String) : undefined,
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
      "Take a screenshot of the Roblox window and return it as an image, so you can see what the player sees. It captures the real window on the computer where the bridge runs (Windows only), so the window must be visible: not minimized and not covered by another window. With focus true it restores and raises the window first. Does not need the executor connection.",
    inputSchema: {
      type: "object",
      properties: {
        max_width: { type: "integer", minimum: 320, maximum: 1920, description: "Scale the image down to this width (default 1280)." },
        focus: { type: "boolean", description: "Restore and raise the window before capturing (default false)." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: async (args) => {
      const query = new URLSearchParams();
      if (args.max_width !== undefined) query.set("max_width", String(clampInt(args.max_width, 320, 1920, 1280)));
      if (args.focus === true) query.set("focus", "1");
      const suffix = query.toString();
      const shot = await bridgeRequest("GET", `/screenshot${suffix ? `?${suffix}` : ""}`, undefined, SCREENSHOT_TIMEOUT_MS);
      return { image: { data: shot.data, mimeType: shot.mimeType }, width: shot.width, height: shot.height, title: shot.title };
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
    name: "clear_logs",
    title: "Clear stored logs",
    description: "Clear the logs and errors stored in the bridge, for all clients or only for one.",
    inputSchema: {
      type: "object",
      properties: { client: { type: "string", description: "Only clear the entries of this client id (default: all)." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

// Every result starts with a status line, so the AI always knows if Roblox is connected.
async function callTool(tool, args) {
  const requestedClient = typeof args.client === "string" && args.client.length > 0 ? args.client : undefined;
  const connection = await assessConnection(tool.probe === true, requestedClient);
  const header = statusLine(connection);

  if (tool.reportsConnection) {
    return formatResult(header, connection, false);
  }

  const bridgeUp = !BRIDGE_DOWN_STATES.has(connection.state);
  if (!bridgeUp || (tool.needsRoblox && connection.state !== "connected")) {
    return { content: [{ type: "text", text: `${header}\n\n${tool.name} was not run.` }], isError: true };
  }

  try {
    // Commands go to the client that was selected when the status was checked.
    const context = { client: tool.needsRoblox ? connection.selectedClient || requestedClient : requestedClient };
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
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: tools.map(({ run, probe, needsRoblox, reportsConnection, ...definition }) => definition),
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
      return { prompts: [] };
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
