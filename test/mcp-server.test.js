"use strict";

// End-to-end test for Superbase: the MCP server over stdio, the bridge and a fake executor.
// It walks through every connection state the AI can see and every tool.

const { spawn } = require("child_process");
const readline = require("readline");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const BRIDGE = path.join(__dirname, "..", "src", "bridge.js");
const MCP = path.join(__dirname, "..", "src", "mcp-server.js");
const PORT = 19731;
const TOKEN_PORT = 19732;
const STUB_PORT = 19733;
const TOKEN = "mcp-test-token-1234567890abcdef";
const CLEAN_ENV = {
  SUPERBASE_CONFIG: "none",
  SUPERBASE_AUTOSTART: "0",
  SUPERBASE_UPDATE_CHECK: "0",
  SUPERBASE_HOME: require("fs").mkdtempSync(path.join(require("os").tmpdir(), "superbase-mcp-test-")),
  SUPERBASE_RECIPES: "",
  SUPERBASE_PORT: "",
  SUPERBASE_TOKEN: "",
  SUPERBASE_CLIENT_URL: "",
  BRIDGE_PORT: "",
  BRIDGE_TOKEN: "",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startBridge(port, token = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [BRIDGE], {
      env: { ...process.env, ...CLEAN_ENV, SUPERBASE_PORT: String(port), SUPERBASE_TOKEN: token },
    });
    child.stdout.on("data", (data) => {
      if (data.toString().includes("listening")) resolve(child);
    });
    child.stderr.on("data", (data) => reject(new Error(data.toString())));
  });
}

function startMcp(port, extraEnv = {}) {
  const child = spawn("node", [MCP], {
    env: { ...process.env, ...CLEAN_ENV, SUPERBASE_PORT: String(port), ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const waiters = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
  });

  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 20000);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  const call = (name, args) => rpc("tools/call", { name, arguments: args });

  return { child, rpc, notify, call };
}

// Reads the arguments back out of a generated snippet: the MCP server writes them as a
// Lua string literal made of plain characters and \ddd byte escapes.
function decodeSnippet(code) {
  const match = code.match(/^local args = game:GetService\("HttpService"\):JSONDecode\(("(?:[^"\\]|\\\d{3})*")\)\n([\s\S]*)$/);
  if (!match) return null;

  const literal = match[1].slice(1, -1);
  const bytes = [];
  for (let i = 0; i < literal.length; i++) {
    if (literal[i] === "\\") {
      bytes.push(Number(literal.slice(i + 1, i + 4)));
      i += 3;
    } else {
      bytes.push(literal.charCodeAt(i));
    }
  }

  const body = match[2];
  const names = {
    "overview of the running game": "game_info",
    "search the instance tree": "find_instances",
    "read the source of a script": "get_script_source",
    "set a property on an instance": "set_property",
    "print the instance tree": "get_hierarchy",
    "list the scripts the game has": "list_scripts",
    "search inside the source code": "search_scripts",
    "record calls to RemoteEvent": "remote_spy",
    "look at and operate the game's GUI": "gui_interact",
    "dump the source code of the game's scripts": "dump_scripts",
    "players and their characters": "player_info",
    "move the local character": "character_control",
    "performance numbers of the running game": "stats",
    "save the state of part of the game": "snapshot",
    "look inside running code": "inspect_code",
    "call a method on an instance": "call_instance",
    "wait until an instance exists": "wait_for_instance",
    "record the HTTP requests": "http_spy",
    "show a toast in the game window": "notify",
    "-- Recipe: List remotes": "recipe:list-remotes",
    "-- Recipe: Test recipe": "recipe:test-recipe",
  };
  const found = Object.keys(names).find((needle) => body.includes(needle));
  return { name: found ? names[found] : "unknown", args: JSON.parse(Buffer.from(bytes).toString("utf8")) };
}

// Connects a fake executor. It answers exec (including the generated snippets), inspect and
// (optionally) ping messages.
function connectExecutor(port, { answerPings = true, token, name = "Tester", userId = 1, delayMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("error", reject);
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "welcome") {
        resolve(ws);
      } else if (message.type === "ping" && answerPings) {
        ws.send(JSON.stringify({ type: "pong", id: message.id }));
      } else if (message.type === "exec") {
        const snippet = decodeSnippet(message.code);
        const answer = () => {
          if (snippet) {
            let value;
            if (snippet.args.path === "game.Missing") {
              value = { error: "Not found at segment: Missing" };
            } else if (snippet.name === "get_hierarchy") {
              value = { snippet: snippet.name, args: snippet.args, nodes: 2, tree: "Workspace [Folder]\n  Map [Model]" };
            } else if (snippet.name === "get_script_source" && snippet.args.path === "game.WithSource") {
              value = { snippet: snippet.name, path: "game.WithSource", source: 'print("hi")\nreturn 1' };
            } else {
              value = { snippet: snippet.name, args: snippet.args, executor: name };
            }
            ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, value: [value] }));
          } else {
            if (message.code.includes("emit log")) {
              ws.send(JSON.stringify({ type: "log", level: "info", message: `log made by ${name}` }));
            }
            ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, value: [`ran: ${message.code}`, name] }));
          }
        };
        if (delayMs > 0) setTimeout(answer, delayMs);
        else answer();
      } else if (message.type === "inspect") {
        ws.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: `Not found at segment: ${message.path}` }));
      }
    });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          token,
          placeId: 777,
          jobId: `job-${userId}`,
          userId,
          userName: name,
          executor: "TestExec 1.0",
          clientVersion: "9.9.9",
        }),
      ),
    );
  });
}

const textOf = (res) => res.result.content[0].text;
const bodyOf = (res) => JSON.parse(textOf(res).split("\n\n").slice(1).join("\n\n"));

async function main() {
  const children = [];
  const LOADER = `loadstring(game:HttpGet("http://127.0.0.1:${PORT}/client.lua"))()`;

  try {
    const mcp = startMcp(PORT);
    children.push(mcp.child);

    // Protocol basics: initialize, instructions, ping, unknown method, tool list.
    let res = await mcp.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.strictEqual(res.result.serverInfo.name, "superbase");
    assert.strictEqual(res.result.serverInfo.title, "Superbase");
    assert.strictEqual(res.result.protocolVersion, "2025-06-18");
    const instructions = res.result.instructions;
    assert.ok(res.result.instructions.includes("roblox_status"), "instructions must tell the AI to check the status");
    assert.ok(res.result.instructions.includes("loadstring"), "instructions must mention the loadstring script");
    mcp.notify("notifications/initialized");

    res = await mcp.rpc("ping");
    assert.deepStrictEqual(res.result, {});
    res = await mcp.rpc("nope/nothing");
    assert.strictEqual(res.error.code, -32601);

    res = await mcp.rpc("tools/list");
    assert.deepStrictEqual(res.result.tools.map((tool) => tool.name).sort(), [
      "call_instance",
      "character_control",
      "clear_logs",
      "execute_lua",
      "find_instances",
      "get_errors",
      "get_game_info",
      "get_hierarchy",
      "get_logs",
      "get_script_source",
      "gui_interact",
      "http_spy",
      "inspect_code",
      "inspect_instance",
      "list_clients",
      "list_scripts",
      "notify",
      "player_info",
      "recipes",
      "remote_spy",
      "roblox_status",
      "run_file",
      "screenshot",
      "search_scripts",
      "semantic_search",
      "set_property",
      "snapshot",
      "stats",
      "wait_for_instance",
      "wait_for_log",
    ]);
    assert.strictEqual(res.result.tools.length, 30);
    for (const tool of res.result.tools) {
      assert.strictEqual(tool.inputSchema.type, "object");
      assert.strictEqual(tool.run, undefined, "implementation must not leak into tools/list");
      assert.strictEqual(tool.probe, undefined);
      assert.strictEqual(tool.needsRoblox, undefined);
      assert.strictEqual(tool.reportsConnection, undefined);
      assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
    }
    const withClient = res.result.tools.filter((tool) => tool.inputSchema.properties.client).map((tool) => tool.name);
    for (const name of ["execute_lua", "get_game_info", "inspect_instance", "get_hierarchy", "find_instances", "list_scripts", "get_script_source", "search_scripts", "remote_spy", "gui_interact", "set_property", "roblox_status", "get_logs", "get_errors", "wait_for_log", "clear_logs", "player_info", "character_control", "stats", "snapshot", "recipes", "semantic_search", "inspect_code", "call_instance", "wait_for_instance", "http_spy", "notify", "run_file"]) {
      assert.ok(withClient.includes(name), `${name} must accept a client id`);
    }
    assert.ok(instructions.includes("list_clients") && instructions.includes("remote_spy") && instructions.includes("semantic_search"), "instructions describe the new tools");
    for (const name of ["inspect_code", "call_instance", "wait_for_instance", "http_spy", "notify", "run_file"]) assert.ok(instructions.includes(name), `instructions mention ${name}`);

    // State: bridge_offline (the bridge is not running yet).
    res = await mcp.call("roblox_status", {});
    assert.strictEqual(res.result.isError, false, "the status tool itself succeeds");
    assert.ok(textOf(res).startsWith("[Superbase] ○ bridge_offline"));
    assert.strictEqual(bodyOf(res).state, "bridge_offline");

    res = await mcp.call("execute_lua", { code: "return 1" });
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("npm start"), "the hint must say how to start the bridge");
    assert.ok(textOf(res).includes("automatic start is turned off"), "the hint says why the bridge was not started for the user");
    res = await mcp.call("recipes", { action: "list" });
    assert.strictEqual(res.result.isError, false, "recipes can be listed without the bridge or a game");

    // State: waiting_for_roblox (the bridge runs, no game is connected).
    children.push(await startBridge(PORT));

    res = await mcp.call("roblox_status", {});
    assert.ok(textOf(res).startsWith("[Superbase] ○ waiting_for_roblox"));
    assert.ok(textOf(res).split("\n")[0].includes(LOADER), "the status line must contain the loadstring script");
    let status = bodyOf(res);
    assert.strictEqual(status.ready, false);
    assert.strictEqual(status.loader, LOADER);
    assert.strictEqual(status.mode, "open");

    res = await mcp.call("get_logs", {});
    assert.strictEqual(res.result.isError, false, "stored logs can be read without a game");
    assert.ok(textOf(res).includes("waiting_for_roblox"));

    for (const [name, args] of [
      ["execute_lua", { code: "return 1" }],
      ["get_game_info", {}],
      ["find_instances", { name: "Part" }],
      ["get_script_source", { path: "game.Workspace.Script" }],
      ["set_property", { path: "game.Workspace.Part", property: "Transparency", value_json: "0.5" }],
      ["get_hierarchy", {}],
      ["list_scripts", {}],
      ["search_scripts", { query: "coins" }],
      ["remote_spy", { action: "status" }],
      ["gui_interact", { action: "list" }],
    ]) {
      res = await mcp.call(name, args);
      assert.strictEqual(res.result.isError, true, `${name} needs a connected game`);
      assert.ok(textOf(res).includes(LOADER), `${name} must show the loadstring script while waiting`);
      assert.ok(textOf(res).includes(`${name} was not run`));
    }

    // The loader URL can be overridden, for example with a public raw GitHub link.
    const hosted = startMcp(PORT, { SUPERBASE_CLIENT_URL: "https://example.test/client.lua" });
    children.push(hosted.child);
    res = await hosted.call("roblox_status", {});
    assert.ok(textOf(res).includes('loadstring(game:HttpGet("https://example.test/client.lua"))()'));
    assert.ok(!textOf(res).split("\n")[0].includes("127.0.0.1"), "the override replaces the local URL in the status line");
    assert.strictEqual(bodyOf(res).loader, 'loadstring(game:HttpGet("https://example.test/client.lua"))()');

    // State: connected.
    const ws = await connectExecutor(PORT);
    ws.send(JSON.stringify({ type: "log", level: "warn", message: "hello from executor" }));
    await sleep(100);

    res = await mcp.call("roblox_status", {});
    assert.strictEqual(res.result.isError, false);
    assert.ok(textOf(res).startsWith("[Superbase] ● connected"));
    assert.ok(textOf(res).includes("place 777"));
    assert.ok(textOf(res).includes("TestExec 1.0"));
    status = bodyOf(res);
    assert.strictEqual(status.state, "connected");
    assert.strictEqual(status.ready, true);
    assert.strictEqual(status.responsive, true);
    assert.strictEqual(typeof status.latencyMs, "number");
    assert.strictEqual(status.place.placeId, 777);
    assert.strictEqual(status.loader, undefined, "no loader is needed once connected");

    res = await mcp.call("get_logs", { level: "warn", limit: 10 });
    assert.strictEqual(res.result.isError, false);
    assert.ok(textOf(res).startsWith("[Superbase] ● connected"), "every result carries the status line");
    assert.ok(textOf(res).includes("hello from executor"));

    res = await mcp.call("get_logs", { contains: "HELLO" });
    assert.strictEqual(bodyOf(res).logs.length, 1);
    res = await mcp.call("get_logs", { contains: "no such text" });
    assert.strictEqual(bodyOf(res).logs.length, 0);
    res = await mcp.call("get_errors", { contains: "no such text", since: 0 });
    assert.strictEqual(res.result.isError, false);

    // execute_lua, inspect_instance and error handling.
    res = await mcp.call("execute_lua", { code: "return 1" });
    assert.strictEqual(res.result.isError, false);
    assert.ok(textOf(res).includes("ran: return 1"));

    res = await mcp.call("execute_lua", {});
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("non-empty"));

    res = await mcp.call("execute_lua", { code: "print('emit log')", capture_logs: true, wait_ms: 200 });
    assert.strictEqual(res.result.isError, false);
    let body = bodyOf(res);
    assert.ok(Array.isArray(body.logs), "capture_logs returns the logs");
    assert.ok(body.logs.some((entry) => entry.message === "log made by Tester"), "the log made during the run is captured");
    assert.deepStrictEqual(body.errors, []);

    res = await mcp.call("execute_lua", { code: "return 1" });
    assert.strictEqual(bodyOf(res).logs, undefined, "no logs unless capture_logs is set");

    res = await mcp.call("inspect_instance", { path: "game.Missing" });
    assert.strictEqual(res.result.isError, true, "a Lua side failure is reported as a tool error");

    res = await mcp.call("does_not_exist", {});
    assert.strictEqual(res.error.code, -32602);

    // The snippet tools.
    res = await mcp.call("get_game_info", {});
    assert.strictEqual(res.result.isError, false);
    assert.strictEqual(bodyOf(res).value.snippet, "game_info");

    res = await mcp.call("find_instances", {});
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("Provide"), "find_instances needs a name or a class");

    res = await mcp.call("find_instances", { name: "Spawn", class_name: "BasePart", root: "game.Workspace", limit: 9999 });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "find_instances");
    assert.deepStrictEqual(body.args, { root: "game.Workspace", name: "Spawn", class_name: "BasePart", limit: 200 });

    res = await mcp.call("find_instances", { class_name: "RemoteEvent" });
    assert.strictEqual(bodyOf(res).value.args.limit, 50, "default limit");

    // Quotes, backslashes, newlines and unicode must survive the Lua string literal.
    const trickyPath = 'game.Workspace.Ünï"cø\\de\n日本語';
    res = await mcp.call("get_script_source", { path: trickyPath });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "get_script_source");
    assert.strictEqual(body.args.path, trickyPath);
    assert.strictEqual(body.args.max_chars, 20000, "default max_chars");

    res = await mcp.call("get_script_source", { path: "game.X", max_chars: 999999 });
    assert.strictEqual(bodyOf(res).value.args.max_chars, 40000, "max_chars is clamped");
    res = await mcp.call("get_script_source", { path: "game.X", max_chars: 5 });
    assert.strictEqual(bodyOf(res).value.args.max_chars, 100);

    res = await mcp.call("get_script_source", {});
    assert.strictEqual(res.result.isError, true);

    res = await mcp.call("get_script_source", { path: "game.Missing" });
    assert.strictEqual(res.result.isError, true, "an error returned by the snippet becomes a tool error");
    assert.ok(textOf(res).includes("Not found at segment: Missing"));

    res = await mcp.call("set_property", {
      path: "game.Workspace.Part",
      property: "Position",
      value_json: '{"type":"Vector3","x":1,"y":2,"z":3}',
    });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "set_property");
    assert.deepStrictEqual(body.args.value, { type: "Vector3", x: 1, y: 2, z: 3 });
    assert.strictEqual(body.args.property, "Position");

    res = await mcp.call("set_property", { path: "game.A", property: "Name", value_json: '"Hello \\"there\\""' });
    assert.strictEqual(bodyOf(res).value.args.value, 'Hello "there"');

    res = await mcp.call("set_property", { path: "game.A", property: "Transparency", value_json: "0.5" });
    assert.strictEqual(bodyOf(res).value.args.value, 0.5);

    res = await mcp.call("set_property", { path: "game.A", property: "Anchored", value_json: "false" });
    assert.strictEqual(bodyOf(res).value.args.value, false);

    res = await mcp.call("set_property", { path: "game.A", property: "Name", value_json: "{not json" });
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("valid JSON"));

    res = await mcp.call("set_property", { path: "game.A", property: "Parent", value_json: "null" });
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("null"));

    res = await mcp.call("set_property", { path: "game.A", property: "", value_json: "1" });
    assert.strictEqual(res.result.isError, true);

    // The tools of 1.3.1: they validate their input and pass it on to the snippets.
    res = await mcp.call("player_info", {});
    assert.deepStrictEqual(bodyOf(res).value.args, { action: "list", player: "", details: false, limit: 50 });
    assert.strictEqual(bodyOf(res).value.snippet, "player_info");
    res = await mcp.call("player_info", { action: "character", player: "Bob", details: true, limit: 500 });
    assert.deepStrictEqual(bodyOf(res).value.args, { action: "character", player: "Bob", details: true, limit: 100 });
    res = await mcp.call("player_info", { action: "kick" });
    assert.strictEqual(res.result.isError, true);

    res = await mcp.call("character_control", { action: "teleport", position: { x: 1, y: 2, z: 3 }, offset_y: 5 });
    assert.strictEqual(bodyOf(res).value.snippet, "character_control");
    assert.deepStrictEqual(bodyOf(res).value.args, { action: "teleport", timeout: 10, position: { x: 1, y: 2, z: 3 }, offset_y: 5 });
    res = await mcp.call("character_control", { action: "walk_to", player: "Alice", timeout: 99 });
    assert.deepStrictEqual(bodyOf(res).value.args, { action: "walk_to", timeout: 30, player: "Alice" });
    res = await mcp.call("character_control", { action: "fly" });
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("teleport or walk_to"));

    res = await mcp.call("stats", {});
    assert.deepStrictEqual(bodyOf(res).value.args, { sample_seconds: 1.5, memory: "summary" });
    res = await mcp.call("stats", { sample_seconds: 60, memory: "detail" });
    assert.deepStrictEqual(bodyOf(res).value.args, { sample_seconds: 5, memory: "detail" });

    res = await mcp.call("snapshot", {});
    assert.strictEqual(bodyOf(res).value.args.action, "take");
    res = await mcp.call("snapshot", { action: "diff", name: "before", keep: true, limit: 999 });
    assert.deepStrictEqual(bodyOf(res).value.args, { action: "diff", limit: 200, keep: true, name: "before" });
    res = await mcp.call("snapshot", { action: "take", path: "game.Workspace.Map", depth: 99, properties: ["Anchored", 5, ""], max_instances: 99999 });
    assert.deepStrictEqual(bodyOf(res).value.args.properties, ["Anchored"]);
    assert.strictEqual(bodyOf(res).value.args.depth, 10);
    assert.strictEqual(bodyOf(res).value.args.max_instances, 5000);
    res = await mcp.call("snapshot", { action: "restore" });
    assert.strictEqual(res.result.isError, true);

    // Recipes: the built-in ones are listed, a saved one can be run, and nothing leaves the folder.
    res = await mcp.call("recipes", {});
    const listed = bodyOf(res).recipes.map((recipe) => recipe.name);
    for (const name of ["list-remotes", "dump-leaderstats", "list-gui-text", "workspace-summary", "list-sounds"]) {
      assert.ok(listed.includes(name), `the built-in recipe ${name} is listed`);
    }
    res = await mcp.call("recipes", { action: "run", name: "list-remotes", args: { contains: "buy" } });
    assert.strictEqual(bodyOf(res).value.snippet, "recipe:list-remotes");
    assert.deepStrictEqual(bodyOf(res).value.args, { contains: "buy" });
    res = await mcp.call("recipes", { action: "run", name: "nope-not-there" });
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("no recipe called"));
    res = await mcp.call("recipes", { action: "run", name: "../package" });
    assert.strictEqual(res.result.isError, true);
    res = await mcp.call("recipes", { action: "bake" });
    assert.strictEqual(res.result.isError, true);

    const recipeDir = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-recipes-"));
    const own = startMcp(PORT, { SUPERBASE_RECIPES: recipeDir });
    children.push(own.child);
    res = await own.call("recipes", { action: "save", name: "test-recipe", title: "Test recipe", description: "Returns one.", usage: "none", code: "return { one = 1 }" });
    assert.strictEqual(res.result.isError, false);
    const saved = fs.readFileSync(path.join(recipeDir, "test-recipe.lua"), "utf8");
    assert.ok(saved.startsWith("-- Recipe: Test recipe\n-- Description: Returns one.\n-- Args: none\n"), saved);
    res = await own.call("recipes", { action: "save", name: "test-recipe", code: "return 2" });
    assert.strictEqual(res.result.isError, true, "an existing recipe is not replaced silently");
    assert.ok(textOf(res).includes("overwrite"));
    res = await own.call("recipes", { action: "save", name: "test-recipe", code: "return 2", overwrite: true });
    assert.strictEqual(res.result.isError, false);
    for (const bad of ["../escape", "a/b", "A B", "", "x".repeat(70)]) {
      res = await own.call("recipes", { action: "save", name: bad, code: "return 1" });
      assert.strictEqual(res.result.isError, true, `the name ${JSON.stringify(bad)} is refused`);
    }
    assert.deepStrictEqual(fs.readdirSync(recipeDir), ["test-recipe.lua"], "nothing was written outside the recipe");
    fs.writeFileSync(path.join(recipeDir, "test-recipe.lua"), "-- Recipe: Test recipe\nreturn args\n");
    res = await own.call("recipes", { action: "run", name: "test-recipe", args: { a: 1 } });
    assert.strictEqual(bodyOf(res).value.snippet, "recipe:test-recipe");
    assert.deepStrictEqual(bodyOf(res).value.args, { a: 1 });
    res = await own.call("recipes", { action: "list" });
    assert.deepStrictEqual(bodyOf(res).recipes.map((recipe) => recipe.name), ["test-recipe"]);
    fs.rmSync(recipeDir, { recursive: true, force: true });

    // wait_for_log: a match, a timeout and validation.
    const waiting = mcp.call("wait_for_log", { contains: "deploy finished", timeout_ms: 5000 });
    await sleep(400);
    ws.send(JSON.stringify({ type: "log", level: "info", message: "Deploy FINISHED in 2s" }));
    res = await waiting;
    assert.strictEqual(res.result.isError, false);
    body = bodyOf(res);
    assert.strictEqual(body.matched, true);
    assert.strictEqual(body.logs[0].message, "Deploy FINISHED in 2s");
    assert.ok(body.waitedMs >= 300);

    const waitingError = mcp.call("wait_for_log", { contains: "kaboom", timeout_ms: 5000 });
    await sleep(300);
    ws.send(JSON.stringify({ type: "error", message: "kaboom happened", trace: "Script:1", script: "game.X" }));
    res = await waitingError;
    body = bodyOf(res);
    assert.strictEqual(body.matched, true);
    assert.strictEqual(body.errors[0].message, "kaboom happened");

    // Old entries do not count: only lines that arrive after the call starts.
    res = await mcp.call("wait_for_log", { contains: "Deploy FINISHED", timeout_ms: 300 });
    assert.strictEqual(res.result.isError, false, "a timeout is a normal result, not an error");
    assert.strictEqual(bodyOf(res).matched, false);

    res = await mcp.call("wait_for_log", { contains: "" });
    assert.strictEqual(res.result.isError, true);

    res = await mcp.call("clear_logs", {});
    assert.strictEqual(res.result.isError, false);

    // New snippet tools: arguments are validated, clamped and passed through.
    res = await mcp.call("get_hierarchy", { root: "game.Workspace", depth: 99, max_nodes: 5, class_name: "Part" });
    let text = textOf(res);
    assert.strictEqual(res.result.isError, false);
    assert.ok(text.includes("```\nWorkspace [Folder]\n  Map [Model]\n```"), "the tree is shown as plain text, not an escaped JSON string");
    const jsonPart = JSON.parse(text.split("\n\n").slice(1).join("\n\n").split("\n\n```")[0]);
    assert.strictEqual(jsonPart.value.tree, undefined, "the tree is not duplicated inside the JSON");
    assert.deepStrictEqual(jsonPart.value.args, { root: "game.Workspace", depth: 8, max_nodes: 10, max_children: 40, class_name: "Part" });

    res = await mcp.call("get_script_source", { path: "game.WithSource" });
    text = textOf(res);
    assert.ok(text.includes('```lua\nprint("hi")\nreturn 1\n```'), "script source is shown as a code block");

    res = await mcp.call("find_instances", { selector: "Model > Part[Anchored=false]", properties: ["Position", "Size"], limit: 5 });
    body = bodyOf(res).value;
    assert.strictEqual(body.args.limit, 5);
    assert.deepStrictEqual(body.args.properties, ["Position", "Size"]);
    assert.deepStrictEqual(body.args.steps, [
      { combinator: "descendant", type: "Model", name: null, attrs: [] },
      { combinator: "child", type: "Part", name: null, attrs: [{ prop: "Anchored", op: "=", value: false }] },
    ]);

    res = await mcp.call("find_instances", { selector: "Model >" });
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("Invalid selector"), "a bad selector explains itself");

    res = await mcp.call("list_scripts", { class_name: "ModuleScript", include_hidden: true, limit: 99999 });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "list_scripts");
    assert.deepStrictEqual(body.args, { class_name: "ModuleScript", include_hidden: true, limit: 500 });

    res = await mcp.call("search_scripts", { query: "coins", mode: "words", context_lines: 9, budget_seconds: 600 });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "search_scripts");
    assert.strictEqual(body.args.budget_seconds, 60, "the search budget is clamped");
    assert.strictEqual(body.args.context_lines, 3);
    assert.strictEqual(body.args.mode, "words");
    assert.strictEqual(body.args.max_matches, 40);
    res = await mcp.call("search_scripts", { query: "" });
    assert.strictEqual(res.result.isError, true);

    res = await mcp.call("remote_spy", { action: "start", ignore: ["Heartbeat", 7], only: "buy", max_calls: 99999, include_own: true });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "remote_spy");
    assert.deepStrictEqual(body.args, { action: "start", only: "buy", ignore: ["Heartbeat", "7"], max_calls: 2000, include_own: true });
    res = await mcp.call("remote_spy", { action: "get", since_id: 12, limit: 5 });
    assert.strictEqual(bodyOf(res).value.args.since_id, 12);
    res = await mcp.call("remote_spy", { action: "explode" });
    assert.strictEqual(res.result.isError, true);
    res = await mcp.call("remote_spy", { action: "block", remotes: ["Buy", 5], include_own: true });
    body = bodyOf(res).value;
    assert.deepStrictEqual(body.args.remotes, ["Buy", "5"]);
    assert.strictEqual(body.args.include_own, true);
    res = await mcp.call("remote_spy", { action: "block" });
    assert.strictEqual(res.result.isError, true, "block needs remotes");
    res = await mcp.call("remote_spy", { action: "unblock" });
    assert.ok(!res.result.isError, "unblock without names releases everything");

    res = await mcp.call("gui_interact", { action: "click", path: "Players.Me.PlayerGui.Main.Play", mode: "mouse" });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "gui_interact");
    assert.strictEqual(body.args.mode, "mouse");
    res = await mcp.call("gui_interact", { action: "click" });
    assert.strictEqual(res.result.isError, true, "click needs a path");
    res = await mcp.call("gui_interact", { action: "set_text", path: "game.A.Box" });
    assert.strictEqual(res.result.isError, true, "set_text needs text");
    res = await mcp.call("gui_interact", { action: "list", limit: 9999 });
    assert.strictEqual(bodyOf(res).value.args.limit, 200);


    // Reverse engineering and small tools (1.4.0).
    res = await mcp.call("inspect_code", { action: "upvalues", path: "game.ReplicatedStorage.Utils", function_name: "addCoins", limit: 9999 });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "inspect_code");
    assert.deepStrictEqual(body.args, { action: "upvalues", path: "game.ReplicatedStorage.Utils", function_name: "addCoins", limit: 100 });
    res = await mcp.call("inspect_code", { action: "gc", name_contains: "buy", kind: "function" });
    assert.strictEqual(bodyOf(res).value.args.name_contains, "buy");
    res = await mcp.call("inspect_code", { action: "upvalues" });
    assert.strictEqual(res.result.isError, true, "upvalues needs a path");
    res = await mcp.call("inspect_code", { action: "connections", path: "game.A.B", signal: "Touched" });
    assert.strictEqual(bodyOf(res).value.args.signal, "Touched");
    res = await mcp.call("inspect_code", { action: "explode" });
    assert.strictEqual(res.result.isError, true);

    res = await mcp.call("call_instance", { action: "fire_remote", path: "game.ReplicatedStorage.Buy", args: ["sword", { __type: "Vector3", x: 1, y: 2, z: 3 }] });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "call_instance");
    assert.deepStrictEqual(body.args.args, ["sword", { __type: "Vector3", x: 1, y: 2, z: 3 }]);
    res = await mcp.call("call_instance", { action: "method", path: "game.Workspace" });
    assert.ok(res.result.isError && textOf(res).includes("'method' is required"), textOf(res));
    res = await mcp.call("call_instance", { action: "fire_signal", path: "game.Workspace.Part" });
    assert.ok(res.result.isError && textOf(res).includes("'signal' is required"), textOf(res));
    res = await mcp.call("call_instance", { action: "fire_remote", path: "game.A.B", args: ["a", null, "b"] });
    assert.ok(res.result.isError && textOf(res).includes("null is not supported"), textOf(res));
    res = await mcp.call("call_instance", { action: "fire_remote", path: "game.A.B", args: "x" });
    assert.ok(res.result.isError && textOf(res).includes("must be a list"), textOf(res));

    res = await mcp.call("wait_for_instance", { path: "game.Workspace.Map", timeout: 999, class_name: "Model" });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "wait_for_instance");
    assert.deepStrictEqual(body.args, { path: "game.Workspace.Map", timeout: 60, class_name: "Model" }, "the timeout is clamped");
    res = await mcp.call("wait_for_instance", { path: "game.Workspace.Map" });
    assert.strictEqual(bodyOf(res).value.args.timeout, 10, "the default timeout is ten seconds");

    res = await mcp.call("http_spy", { action: "start", max_calls: 99999, max_body: 99999, url_contains: "api." });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "http_spy");
    assert.strictEqual(body.args.max_calls, 1000);
    assert.strictEqual(body.args.max_body, 4000);
    res = await mcp.call("http_spy", { action: "get", since_id: 3, method: "POST", limit: 500 });
    assert.deepStrictEqual([bodyOf(res).value.args.method, bodyOf(res).value.args.limit, bodyOf(res).value.args.since_id], ["POST", 100, 3]);
    res = await mcp.call("http_spy", { action: "explode" });
    assert.strictEqual(res.result.isError, true);

    res = await mcp.call("notify", { title: "Done", text: "All scripts dumped", kind: "success" });
    body = bodyOf(res).value;
    assert.strictEqual(body.snippet, "notify");
    assert.deepStrictEqual(body.args, { title: "Done", text: "All scripts dumped", kind: "success" });
    res = await mcp.call("notify", { title: "" });
    assert.strictEqual(res.result.isError, true);

    // run_file reads a file on this computer and runs its code.
    const luaDir = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-runfile-"));
    const luaFile = path.join(luaDir, "hello.lua");
    fs.writeFileSync(luaFile, 'print("from a file")\nreturn 7\n');
    res = await mcp.call("run_file", { path: luaFile });
    assert.strictEqual(res.result.isError, false, textOf(res));
    assert.ok(textOf(res).includes('ran: print(\\"from a file\\")') || textOf(res).includes('from a file'), "the file's code reaches the executor");
    assert.strictEqual(bodyOf(res).file, luaFile);
    assert.strictEqual(bodyOf(res).bytes, fs.statSync(luaFile).size);
    res = await mcp.call("run_file", { path: path.join(luaDir, "missing.lua") });
    assert.ok(res.result.isError && textOf(res).includes("There is no file"), textOf(res));
    fs.writeFileSync(path.join(luaDir, "notes.md"), "x");
    res = await mcp.call("run_file", { path: path.join(luaDir, "notes.md") });
    assert.ok(res.result.isError && textOf(res).includes("not a .lua"), textOf(res));
    fs.writeFileSync(path.join(luaDir, "big.lua"), "-- ".padEnd(600 * 1024, "x"));
    res = await mcp.call("run_file", { path: path.join(luaDir, "big.lua") });
    assert.ok(res.result.isError && textOf(res).includes("limit"), textOf(res));
    fs.writeFileSync(path.join(luaDir, "empty.lua"), "  \n");
    res = await mcp.call("run_file", { path: path.join(luaDir, "empty.lua") });
    assert.ok(res.result.isError && textOf(res).includes("empty"), textOf(res));
    res = await mcp.call("run_file", { path: luaDir });
    assert.ok(res.result.isError, "a folder is refused");
    fs.rmSync(luaDir, { recursive: true, force: true });


    // Recipe sharing: the checks that need no network. (The download itself is covered by recipe-import.test.js.)
    res = await mcp.call("recipes", { action: "preview_import", url: "https://evil.example.com/a.lua" });
    assert.ok(res.result.isError && textOf(res).includes("not on the list"), textOf(res));
    res = await mcp.call("recipes", { action: "preview_import", url: "http://raw.githubusercontent.com/o/r/main/a.lua" });
    assert.ok(res.result.isError && textOf(res).includes("https"), textOf(res));
    res = await mcp.call("recipes", { action: "preview_import" });
    assert.ok(res.result.isError, "preview_import needs a url");
    res = await mcp.call("recipes", { action: "import", url: "https://raw.githubusercontent.com/o/r/main/a.lua" });
    assert.ok(res.result.isError && textOf(res).includes("confirm true"), "import needs confirm");
    res = await mcp.call("recipes", { action: "import", url: "https://raw.githubusercontent.com/o/r/main/a.lua", confirm: "yes" });
    assert.ok(res.result.isError && textOf(res).includes("confirm true"), "only the boolean true confirms");
    res = await mcp.call("recipes", { action: "import", url: "https://evil.example.com/a.lua", confirm: true });
    assert.ok(res.result.isError && textOf(res).includes("not on the list"), "a refused host is refused with confirm too");
    res = await mcp.call("recipes", { action: "explode" });
    assert.ok(res.result.isError && textOf(res).includes("preview_import"), "the error lists the actions");

    // Prompts.
    res = await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.deepStrictEqual(res.result.capabilities, { tools: {}, prompts: {} });
    res = await mcp.rpc("prompts/list");
    assert.deepStrictEqual(res.result.prompts.map((prompt) => prompt.name), ["diagnose", "find-code", "explain-game", "trace-remote", "performance-check", "why-error"]);
    assert.ok(res.result.prompts.find((prompt) => prompt.name === "find-code").arguments[0].required === true);
    res = await mcp.rpc("prompts/get", { name: "find-code", arguments: { what: "gives coins" } });
    assert.ok(res.result.messages[0].content.text.includes("gives coins") && res.result.messages[0].role === "user");
    res = await mcp.rpc("prompts/get", { name: "find-code", arguments: {} });
    assert.strictEqual(res.error.code, -32602, "a missing argument is an invalid params error");
    res = await mcp.rpc("prompts/get", { name: "nope" });
    assert.strictEqual(res.error.code, -32602);

    // Screenshots need Windows, so the Linux test machine gets a clear error from the bridge.
    res = await mcp.call("screenshot", {});
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("only supported on Windows"));

    // Several Roblox windows at once.
    const second = await connectExecutor(PORT, { name: "Second", userId: 2 });
    await sleep(150);

    res = await mcp.call("roblox_status", {});
    assert.ok(textOf(res).split("\n")[0].includes("2 clients connected"), "the status line shows the client count");
    status = bodyOf(res);
    assert.strictEqual(status.clientCount, 2);
    assert.strictEqual(status.clients.length, 2);

    res = await mcp.call("list_clients", {});
    body = bodyOf(res);
    assert.strictEqual(res.result.isError, false);
    assert.deepStrictEqual(body.clients.map((client) => client.userName), ["Tester", "Second"]);
    const secondId = body.clients[1].id;
    const firstId = body.clients[0].id;
    assert.strictEqual(body.clients[1].isDefault, true, "the newest client is the default");
    assert.strictEqual(body.clients[0].isDefault, false);

    res = await mcp.call("execute_lua", { code: "return 1" });
    assert.deepStrictEqual(bodyOf(res).value, ["ran: return 1", "Second"], "no client id means the newest client");
    res = await mcp.call("execute_lua", { code: "return 1", client: firstId });
    assert.deepStrictEqual(bodyOf(res).value, ["ran: return 1", "Tester"], "a client id routes the command");
    assert.ok(textOf(res).split("\n")[0].includes(`${firstId} (Tester)`), "the status line names the selected client");
    res = await mcp.call("get_game_info", { client: firstId });
    assert.strictEqual(bodyOf(res).value.executor, "Tester");
    res = await mcp.call("find_instances", { name: "x", client: secondId });
    assert.strictEqual(bodyOf(res).value.executor, "Second");

    res = await mcp.call("execute_lua", { code: "return 1", client: "c99" });
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("unknown_client"));
    assert.ok(textOf(res).includes(`${firstId} (Tester)`) && textOf(res).includes(`${secondId} (Second)`), "the hint lists the connected clients");
    assert.ok(textOf(res).includes("execute_lua was not run"));
    res = await mcp.call("roblox_status", { client: "c99" });
    assert.ok(textOf(res).startsWith("[Superbase] ○ unknown_client"));
    assert.strictEqual(bodyOf(res).ready, false);

    // Logs carry the client id, and capture_logs only reports the client that ran the code.
    res = await mcp.call("execute_lua", { code: "print('emit log')", capture_logs: true, wait_ms: 200, client: firstId });
    body = bodyOf(res);
    assert.deepStrictEqual(body.logs.map((entry) => entry.message), ["log made by Tester"]);
    assert.strictEqual(body.logs[0].client, firstId);
    res = await mcp.call("execute_lua", { code: "print('emit log')", capture_logs: true, wait_ms: 200, client: secondId });
    assert.deepStrictEqual(bodyOf(res).logs.map((entry) => entry.message), ["log made by Second"]);

    res = await mcp.call("get_logs", { contains: "log made by", client: secondId });
    assert.deepStrictEqual(bodyOf(res).logs.map((entry) => entry.client), [secondId]);
    res = await mcp.call("get_logs", { contains: "log made by" });
    assert.deepStrictEqual(bodyOf(res).logs.map((entry) => entry.client).sort(), [firstId, secondId].sort(), "without a client id the logs of all clients are returned");

    res = await mcp.call("clear_logs", { client: secondId });
    assert.strictEqual(bodyOf(res).client, secondId);
    res = await mcp.call("get_logs", { contains: "log made by" });
    assert.ok(bodyOf(res).logs.every((entry) => entry.client !== secondId), "only the chosen client's entries were cleared");
    assert.deepStrictEqual(bodyOf(res).logs.map((entry) => entry.client), [firstId]);

    // A slow command can be given more time, and a short timeout fails fast.
    const slow = await connectExecutor(PORT, { name: "Slow", userId: 3, delayMs: 1800 });
    await sleep(100);
    res = await mcp.call("execute_lua", { code: "return 1", timeout_ms: 1000 });
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("Timed out after 1 seconds"), textOf(res));
    res = await mcp.call("execute_lua", { code: "return 2", timeout_ms: 5000 });
    assert.strictEqual(res.result.isError, false);
    assert.deepStrictEqual(bodyOf(res).value, ["ran: return 2", "Slow"]);
    slow.close();
    second.close();
    await sleep(300);

    res = await mcp.call("roblox_status", {});
    assert.strictEqual(bodyOf(res).clientCount, 1, "the other windows left");
    assert.strictEqual(bodyOf(res).selectedClient, firstId);

    // The executor disconnects: back to waiting_for_roblox, with the loader again.
    ws.close();
    await sleep(200);
    res = await mcp.call("roblox_status", {});
    assert.ok(textOf(res).startsWith("[Superbase] ○ waiting_for_roblox"));
    assert.ok(textOf(res).includes(LOADER));
    assert.strictEqual(typeof bodyOf(res).lastDisconnectedSecAgo, "number");

    res = await mcp.call("execute_lua", { code: "return 1" });
    assert.strictEqual(res.result.isError, true);

    // State: unresponsive (connected, but it does not answer pings).
    const silent = await connectExecutor(PORT, { answerPings: false });
    res = await mcp.call("roblox_status", {});
    assert.strictEqual(res.result.isError, false);
    assert.ok(textOf(res).startsWith("[Superbase] ○ unresponsive"));
    assert.strictEqual(bodyOf(res).ready, false);
    silent.terminate();

    // Image results: a stub bridge answers the screenshot request like the real one does on Windows.
    const seen = [];
    const stub = http.createServer((req, res2) => {
      seen.push(req.url);
      res2.setHeader("content-type", "application/json");
      if (req.url.startsWith("/status")) {
        res2.end(JSON.stringify({ connected: false, state: "waiting_for_roblox", clients: [], clientCount: 0, logCount: 0, errorCount: 0 }));
      } else if (req.url.startsWith("/screenshot")) {
        res2.end(JSON.stringify({ ok: true, mimeType: "image/jpeg", data: "QUJD", width: 640, height: 360, title: "Roblox" }));
      } else {
        res2.statusCode = 404;
        res2.end(JSON.stringify({ error: "Not found" }));
      }
    });
    await new Promise((resolve) => stub.listen(STUB_PORT, "127.0.0.1", resolve));
    const stubbed = startMcp(STUB_PORT);
    children.push(stubbed.child);
    res = await stubbed.call("screenshot", { max_width: 640, focus: true });
    assert.strictEqual(res.result.isError, false);
    assert.strictEqual(res.result.content.length, 2);
    assert.strictEqual(res.result.content[0].type, "text");
    assert.ok(res.result.content[0].text.includes("640") && !res.result.content[0].text.includes("QUJD"), "the text part has the size but not the image data");
    assert.deepStrictEqual(res.result.content[1], { type: "image", data: "QUJD", mimeType: "image/jpeg" });
    assert.ok(seen.some((url) => url === "/screenshot?max_width=640&focus=1"), seen.join(" "));
    res = await stubbed.call("screenshot", { max_width: 99999 });
    assert.ok(seen.some((url) => url === "/screenshot?max_width=1920&focus=1"), "the width is clamped and Roblox is raised by default");
    await stubbed.call("screenshot", { max_width: 800, focus: false });
    assert.ok(seen.some((url) => url === "/screenshot?max_width=800"), "focus false leaves the windows alone");
    stub.close();

    // Token mode: the bridge is protected, so the MCP config must carry the same token.
    children.push(await startBridge(TOKEN_PORT, TOKEN));

    const noToken = startMcp(TOKEN_PORT);
    children.push(noToken.child);
    res = await noToken.call("roblox_status", {});
    assert.ok(textOf(res).includes("token_mismatch"));
    assert.ok(textOf(res).includes("requires a token"), "the hint explains that a token is needed");
    res = await noToken.call("get_logs", {});
    assert.strictEqual(res.result.isError, true);

    const wrongToken = startMcp(TOKEN_PORT, { BRIDGE_TOKEN: "wrong-token-wrong-token-1234" });
    children.push(wrongToken.child);
    res = await wrongToken.call("roblox_status", {});
    assert.ok(textOf(res).includes("token_mismatch"));
    assert.ok(textOf(res).includes("rejected this server's token"));

    const goodToken = startMcp(TOKEN_PORT, { BRIDGE_TOKEN: TOKEN });
    children.push(goodToken.child);
    res = await goodToken.call("roblox_status", {});
    assert.ok(textOf(res).startsWith("[Superbase] ○ waiting_for_roblox"));
    assert.ok(!textOf(res).includes("loadstring"), "token mode has no public loader");
    assert.ok(textOf(res).includes("roblox/client.lua"));

    const tokenExecutor = await connectExecutor(TOKEN_PORT, { token: TOKEN });
    res = await goodToken.call("execute_lua", { code: "return 2" });
    assert.strictEqual(res.result.isError, false);
    assert.ok(textOf(res).includes("ran: return 2"));
    tokenExecutor.close();

    // Automatic start: the MCP server starts the bridge itself when nobody did, and says so once.
    const AUTO_PORT = 19736;
    const autoHome = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-autostart-"));
    const auto = startMcp(AUTO_PORT, { SUPERBASE_AUTOSTART: "1", SUPERBASE_HOME: autoHome });
    children.push(auto.child);
    let autoPid = null;
    try {
      res = await auto.call("roblox_status", {});
      assert.ok(textOf(res).includes("waiting_for_roblox"), textOf(res));
      assert.ok(textOf(res).includes("started in the background"), "the first answer says the bridge was started");
      autoPid = JSON.parse(fs.readFileSync(path.join(autoHome, "bridge.json"), "utf8")).pid;
      assert.ok(autoPid > 0, "the state file holds the process id");
      assert.ok(fs.existsSync(path.join(autoHome, "bridge.log")), "the bridge writes a log file");
      res = await auto.call("roblox_status", {});
      assert.ok(!textOf(res).includes("started in the background"), "the note appears only once");
      assert.strictEqual(bodyOf(res).bridgePid, autoPid);
    } finally {
      if (autoPid) {
        try {
          process.kill(autoPid);
        } catch {
          // Already gone.
        }
      }
    }

    // When the bridge cannot be started, the hint says why and does not try again right away.
    const broken = startMcp(19737, { SUPERBASE_AUTOSTART: "1", SUPERBASE_HOME: path.join(autoHome, "file-not-folder") });
    children.push(broken.child);
    fs.writeFileSync(path.join(autoHome, "file-not-folder"), "x");
    res = await broken.call("roblox_status", {});
    assert.ok(textOf(res).includes("bridge_offline") && textOf(res).includes("could not be started automatically"), textOf(res));
    fs.rmSync(autoHome, { recursive: true, force: true });

    // A bridge on another computer: never started from here, and the hint says so.
    const away = startMcp(19738, { SUPERBASE_HOST: "superbase-bridge.invalid", SUPERBASE_AUTOSTART: "1", SUPERBASE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "superbase-remote-")) });
    children.push(away.child);
    res = await away.call("roblox_status", {});
    assert.ok(textOf(res).includes("bridge_offline") && textOf(res).includes("another computer"), textOf(res));
    assert.ok(!textOf(res).includes("started in the background"), "a remote bridge is never started from here");

    // The same through a real network address of this machine, when it has one.
    const lan = Object.values(os.networkInterfaces()).flat().find((nic) => nic && nic.family === "IPv4" && !nic.internal);
    if (lan) {
      const netBridge = spawn("node", [BRIDGE], { env: { ...process.env, ...CLEAN_ENV, SUPERBASE_PORT: "19739", SUPERBASE_HOST: "0.0.0.0", SUPERBASE_TOKEN: TOKEN } });
      children.push(netBridge);
      await new Promise((resolve, reject) => {
        netBridge.stdout.on("data", (data) => data.toString().includes("listening") && resolve());
        netBridge.stderr.on("data", (data) => reject(new Error(data.toString())));
      });
      const viaLan = startMcp(19739, { SUPERBASE_HOST: lan.address, SUPERBASE_TOKEN: TOKEN });
      children.push(viaLan.child);
      res = await viaLan.call("roblox_status", {});
      assert.ok(textOf(res).includes("waiting_for_roblox"), textOf(res));
      assert.strictEqual(bodyOf(res).mode, "token");
    }

    // Safe mode: tools that change the game are hidden or refused, reading still works.
    const safe = startMcp(PORT, { SUPERBASE_READ_ONLY: "1" });
    children.push(safe.child);
    res = await safe.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.ok(res.result.instructions.includes("Safe mode is ON"), "the instructions say safe mode is on");
    res = await safe.rpc("tools/list");
    const safeNames = res.result.tools.map((tool) => tool.name);
    for (const hidden of ["execute_lua", "set_property", "character_control"]) assert.ok(!safeNames.includes(hidden), `${hidden} is hidden in safe mode`);
    for (const shown of ["get_hierarchy", "search_scripts", "remote_spy", "gui_interact", "recipes", "roblox_status"]) assert.ok(safeNames.includes(shown), `${shown} stays in safe mode`);
    for (const hidden of ["call_instance", "run_file"]) assert.ok(!safeNames.includes(hidden), `${hidden} is hidden in safe mode`);
    for (const shown of ["inspect_code", "wait_for_instance", "http_spy", "notify"]) assert.ok(safeNames.includes(shown), `${shown} stays in safe mode`);
    res = await safe.call("execute_lua", { code: "return 1" });
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("Safe mode is on"), textOf(res));
    res = await safe.call("remote_spy", { action: "block", remotes: ["Buy"] });
    assert.ok(res.result.isError && textOf(res).includes("Safe mode is on"), "blocking is refused");
    res = await safe.call("gui_interact", { action: "click", path: "game.A.B" });
    assert.ok(res.result.isError && textOf(res).includes("Safe mode is on"), "clicking is refused");
    res = await safe.call("recipes", { action: "save", name: "x-recipe", code: "return 1" });
    assert.ok(res.result.isError && textOf(res).includes("Safe mode is on"), "saving a recipe is refused");
    res = await safe.call("recipes", { action: "run", name: "list-remotes" });
    assert.ok(res.result.isError && textOf(res).includes("Safe mode is on"), "running a recipe is refused");
    res = await safe.call("recipes", { action: "import", url: "https://raw.githubusercontent.com/o/r/main/a.lua", confirm: true });
    assert.ok(res.result.isError && textOf(res).includes("Safe mode is on"), "importing a recipe is refused");
    res = await safe.call("recipes", { action: "preview_import", url: "https://evil.example.com/a.lua" });
    assert.ok(res.result.isError && !textOf(res).includes("Safe mode is on"), "previewing is not a write, the host check answers");
    res = await safe.rpc("prompts/list");
    assert.strictEqual(res.result.prompts.length, 6, "prompts stay in safe mode");
    res = await safe.call("recipes", { action: "list" });
    assert.ok(!res.result.isError, "listing recipes still works");
    res = await safe.call("remote_spy", { action: "status" });
    assert.ok(textOf(res).includes("Safe mode is on: tools that change") || !res.result.isError, "reading tools run");
    res = await safe.call("get_hierarchy", { path: "game" });
    assert.ok(!res.result.isError || !textOf(res).includes("Safe mode is on, "), "read tools are not refused");

    console.log("ALL SUPERBASE CHECKS PASSED");
  } finally {
    for (const child of children) child.kill();
  }
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
