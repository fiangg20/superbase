"use strict";

// End-to-end test for Superbase: the MCP server over stdio, the bridge and a fake executor.
// It walks through every connection state the AI can see and every tool.

const { spawn } = require("child_process");
const readline = require("readline");
const assert = require("assert");
const path = require("path");
const WebSocket = require("ws");

const BRIDGE = path.join(__dirname, "..", "src", "bridge.js");
const MCP = path.join(__dirname, "..", "src", "mcp-server.js");
const PORT = 19731;
const TOKEN_PORT = 19732;
const TOKEN = "mcp-test-token-1234567890abcdef";
const CLEAN_ENV = {
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
  };
  const found = Object.keys(names).find((needle) => body.includes(needle));
  return { name: found ? names[found] : "unknown", args: JSON.parse(Buffer.from(bytes).toString("utf8")) };
}

// Connects a fake executor. It answers exec (including the generated snippets), inspect and
// (optionally) ping messages.
function connectExecutor(port, { answerPings = true, token } = {}) {
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
        if (snippet) {
          const value =
            snippet.args.path === "game.Missing"
              ? { error: "Not found at segment: Missing" }
              : { snippet: snippet.name, args: snippet.args };
          ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, value: [value] }));
        } else {
          if (message.code.includes("emit log")) {
            ws.send(JSON.stringify({ type: "log", level: "info", message: "log made by the code" }));
          }
          ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, value: [`ran: ${message.code}`] }));
        }
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
          jobId: "job",
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
    assert.ok(res.result.instructions.includes("roblox_status"), "instructions must tell the AI to check the status");
    assert.ok(res.result.instructions.includes("loadstring"), "instructions must mention the loadstring script");
    mcp.notify("notifications/initialized");

    res = await mcp.rpc("ping");
    assert.deepStrictEqual(res.result, {});
    res = await mcp.rpc("nope/nothing");
    assert.strictEqual(res.error.code, -32601);

    res = await mcp.rpc("tools/list");
    assert.deepStrictEqual(res.result.tools.map((tool) => tool.name).sort(), [
      "clear_logs",
      "execute_lua",
      "find_instances",
      "get_errors",
      "get_game_info",
      "get_logs",
      "get_script_source",
      "inspect_instance",
      "roblox_status",
      "set_property",
      "wait_for_log",
    ]);
    for (const tool of res.result.tools) {
      assert.strictEqual(tool.inputSchema.type, "object");
      assert.strictEqual(tool.run, undefined, "implementation must not leak into tools/list");
      assert.strictEqual(tool.probe, undefined);
      assert.strictEqual(tool.needsRoblox, undefined);
      assert.strictEqual(tool.reportsConnection, undefined);
    }

    // State: bridge_offline (the bridge is not running yet).
    res = await mcp.call("roblox_status", {});
    assert.strictEqual(res.result.isError, false, "the status tool itself succeeds");
    assert.ok(textOf(res).startsWith("[Superbase] ○ bridge_offline"));
    assert.strictEqual(bodyOf(res).state, "bridge_offline");

    res = await mcp.call("execute_lua", { code: "return 1" });
    assert.strictEqual(res.result.isError, true);
    assert.ok(textOf(res).includes("npm start"), "the hint must say how to start the bridge");

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
    assert.ok(body.logs.some((entry) => entry.message === "log made by the code"), "the log made during the run is captured");
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

    console.log("ALL SUPERBASE CHECKS PASSED");
  } finally {
    for (const child of children) child.kill();
  }
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
