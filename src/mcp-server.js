"use strict";

// Superbase MCP server (stdio transport).
// Connects any MCP-capable AI to a live Roblox executor session through the local
// Superbase bridge (bridge.js). It has no dependencies.
// stdout is reserved for protocol messages; diagnostics must go to stderr.

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const VERSION = "1.2.0";
const PORT = Number(process.env.SUPERBASE_PORT || process.env.BRIDGE_PORT || 9731);
const TOKEN = process.env.SUPERBASE_TOKEN || process.env.BRIDGE_TOKEN || "";
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Set this to a public raw URL of roblox/client.lua if you host it somewhere (for example GitHub).
const CLIENT_URL_OVERRIDE = process.env.SUPERBASE_CLIENT_URL || "";
const LUA_DIR = path.join(__dirname, "lua");
const REQUEST_TIMEOUT_MS = 25000;
const STATUS_TIMEOUT_MS = 6000;
const MAX_OUTPUT_CHARS = 50000;
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "superbase", title: "Superbase", version: VERSION };

const INSTRUCTIONS = [
  "Superbase connects you to a live Roblox executor session on the user's computer.",
  "You can read the console and script errors, search and inspect the instance tree, read script sources, change properties and run Lua inside the running game.",
  "",
  "Connection awareness:",
  "- Call roblox_status first in every session, and again whenever a tool fails. It actively pings the Roblox client.",
  "- Every tool result begins with a [Superbase] status line that shows the current connection state.",
  "- States: connected (all tools work); waiting_for_roblox (the bridge runs but no game is connected); unresponsive (a client is connected but does not answer: the game may be frozen, loading or closing); bridge_offline (the bridge is not running: ask the user to start it with npm start); token_mismatch (the bridge and this MCP config disagree about the token).",
  "- When the state is waiting_for_roblox, the status line contains a one-line loadstring script. Show it to the user in a code block so they can run it in their executor, then wait for them.",
  "- When the state is not connected, do not retry in a loop. Tell the user what is missing and wait for them.",
  "",
  "Working with the game:",
  "- get_game_info gives an overview, find_instances searches the tree, inspect_instance reads one instance and get_script_source reads a script.",
  "- To check the effect of an action, use execute_lua with capture_logs, or wait_for_log to wait for a specific console line.",
  "- Logs and errors are stored by the bridge, so get_logs and get_errors still work while waiting_for_roblox.",
  "",
  "Safety:",
  "- execute_lua and set_property change the running game with the executor's full permissions. Only do what the user asked for, and explain anything that changes the game or the user's files before you do it.",
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
async function assessConnection(probe) {
  try {
    const status = await bridgeRequest("GET", probe ? "/status?probe=1" : "/status", undefined, STATUS_TIMEOUT_MS);

    let state = "waiting_for_roblox";
    if (status.connected) {
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
    if (connection.place && connection.place.placeId) parts.push(`place ${connection.place.placeId}`);
    if (connection.executor) parts.push(connection.executor);
    if (typeof connection.latencyMs === "number") parts.push(`${connection.latencyMs} ms`);
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
async function runSnippet(name, args) {
  const code = `local args = game:GetService("HttpService"):JSONDecode(${luaString(JSON.stringify(args))})\n${loadSnippet(name)}`;
  const result = await bridgeRequest("POST", "/exec", { code });

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

function requirePath(args) {
  if (typeof args.path !== "string" || args.path.length === 0) {
    throw new Error("'path' must be a non-empty string.");
  }
  return args.path;
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
    const logQuery = new URLSearchParams({ since: String(since), contains, limit: "50" });
    if (args.level) logQuery.set("level", String(args.level));
    const logs = (await bridgeRequest("GET", `/logs?${logQuery}`)).logs;

    let errors = [];
    if (includeErrors) {
      const errorQuery = new URLSearchParams({ since: String(since), contains, limit: "50" });
      errors = (await bridgeRequest("GET", `/errors?${errorQuery}`)).errors;
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

const tools = [
  {
    name: "roblox_status",
    title: "Roblox connection status",
    description:
      "Check whether Superbase is connected to a running Roblox game. Actively pings the Roblox client and returns the connection state (connected, waiting_for_roblox, unresponsive, bridge_offline or token_mismatch), the place, the executor, the latency and the number of stored logs and errors. While waiting_for_roblox it also returns the loadstring script the user must run. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    probe: true,
    reportsConnection: true,
  },
  {
    name: "get_game_info",
    title: "Get game info",
    description:
      "Get an overview of the running game: place name and creator, server job id, the local player, the player list and performance (physics FPS, memory, ping). Requires the connected state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    needsRoblox: true,
    run: () => runSnippet("game_info", {}),
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
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args) => {
      const query = new URLSearchParams();
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      if (args.level) query.set("level", String(args.level));
      if (args.contains) query.set("contains", String(args.contains));
      if (args.since !== undefined) query.set("since", String(args.since));
      const suffix = query.toString();
      return bridgeRequest("GET", `/logs${suffix ? `?${suffix}` : ""}`);
    },
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
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args) => {
      const query = new URLSearchParams();
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      if (args.contains) query.set("contains", String(args.contains));
      if (args.since !== undefined) query.set("since", String(args.since));
      const suffix = query.toString();
      return bridgeRequest("GET", `/errors${suffix ? `?${suffix}` : ""}`);
    },
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
      },
      required: ["contains"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: waitForLog,
  },
  {
    name: "execute_lua",
    title: "Run Lua in Roblox",
    description:
      "Run Lua code inside the connected Roblox executor. Returns the serialized return values, or the error with a traceback. Set capture_logs to also get the console lines and script errors that appeared while it ran. The code runs with the executor's full permissions, so only run code the user asked for. Requires the connected state.",
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
      },
      required: ["code"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    needsRoblox: true,
    run: async (args) => {
      if (typeof args.code !== "string" || args.code.length === 0) {
        throw new Error("'code' must be a non-empty string.");
      }
      if (args.capture_logs !== true) {
        return bridgeRequest("POST", "/exec", { code: args.code });
      }

      const waitMs = clampInt(args.wait_ms, 0, 5000, 500);
      const since = (await bridgeRequest("GET", "/logs?limit=1")).now;
      const result = await bridgeRequest("POST", "/exec", { code: args.code });
      await sleep(waitMs);
      const logs = (await bridgeRequest("GET", `/logs?since=${since}&limit=200`)).logs;
      const errors = (await bridgeRequest("GET", `/errors?since=${since}&limit=50`)).errors;
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
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    needsRoblox: true,
    run: (args) =>
      bridgeRequest("POST", "/inspect", {
        path: typeof args.path === "string" && args.path.length > 0 ? args.path : "game",
        properties: Array.isArray(args.properties) ? args.properties.map(String) : [],
      }),
  },
  {
    name: "find_instances",
    title: "Find instances",
    description:
      "Search the instance tree by name and/or class. Returns the full path and class of each match, and whether the result list was cut off. Requires the connected state.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Dotted path to search under (default game)." },
        name: { type: "string", description: "Case-insensitive part of the instance name." },
        class_name: {
          type: "string",
          description: "Class to match, base classes included (for example BasePart, RemoteEvent or LocalScript).",
        },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum number of results (default 50)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    needsRoblox: true,
    run: (args) => {
      if (!args.name && !args.class_name) {
        throw new Error("Provide 'name', 'class_name' or both.");
      }
      return runSnippet("find_instances", {
        root: args.root,
        name: args.name,
        class_name: args.class_name,
        limit: clampInt(args.limit, 1, 200, 50),
      });
    },
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
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    needsRoblox: true,
    run: (args) =>
      runSnippet("get_script_source", {
        path: requirePath(args),
        max_chars: clampInt(args.max_chars, 100, 40000, 20000),
      }),
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
      },
      required: ["path", "property", "value_json"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    needsRoblox: true,
    run: (args) => {
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
      return runSnippet("set_property", { path: args.path, property: args.property, value });
    },
  },
  {
    name: "clear_logs",
    title: "Clear stored logs",
    description: "Clear the logs and errors stored in the bridge.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: () => bridgeRequest("POST", "/clear"),
  },
];

function formatResult(header, data, isError) {
  let body = JSON.stringify(data, null, 2);
  if (body.length > MAX_OUTPUT_CHARS) {
    body = `${body.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated]`;
  }
  return { content: [{ type: "text", text: `${header}\n\n${body}` }], isError };
}

// Every result starts with a status line, so the AI always knows if Roblox is connected.
async function callTool(tool, args) {
  const connection = await assessConnection(tool.probe === true);
  const header = statusLine(connection);

  if (tool.reportsConnection) {
    return formatResult(header, connection, false);
  }

  const bridgeUp = !BRIDGE_DOWN_STATES.has(connection.state);
  if (!bridgeUp || (tool.needsRoblox && connection.state !== "connected")) {
    return { content: [{ type: "text", text: `${header}\n\n${tool.name} was not run.` }], isError: true };
  }

  try {
    const data = await tool.run(args);
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
