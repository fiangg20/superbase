"use strict";

// Semantic search: chunking, Ollama embeddings (a fake server), the index on disk, and the MCP tool end to end.

const { spawn } = require("child_process");
const readline = require("readline");
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const semantic = require("../src/semantic");

const BRIDGE = path.join(__dirname, "..", "src", "bridge.js");
const MCP = path.join(__dirname, "..", "src", "mcp-server.js");
const BRIDGE_PORT = 18791;
const OLLAMA_PORT = 18792;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-semantic-test-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A stand-in for Ollama: words are hashed into a 96 dimensional bag of words, so texts that share words are close.
function fakeEmbedding(text) {
  const vector = new Array(96).fill(0);
  for (const word of String(text).toLowerCase().match(/[a-z]{3,}/g) || []) {
    let hash = 7;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
    vector[hash % 96] += 1;
  }
  return vector;
}

function startFakeOllama({ missingModel = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      seen.push({ url: req.url, body });
      res.setHeader("content-type", "application/json");
      if (req.url !== "/api/embed") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no such route" }));
      } else if (missingModel || body.model === "ghost-model") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `model "${body.model}" not found, try pulling it first` }));
      } else {
        res.end(JSON.stringify({ model: body.model, embeddings: body.input.map(fakeEmbedding) }));
      }
    });
  });
  return new Promise((resolve) => server.listen(OLLAMA_PORT, "127.0.0.1", () => resolve({ server, seen })));
}

function testChunking() {
  const lines = [];
  for (let i = 0; i < 6; i += 1) {
    lines.push(`local function handler${i}(player)`);
    for (let j = 0; j < 8; j += 1) lines.push(`    print("handler ${i} step ${j} for the player")`);
    lines.push("end", "");
  }
  const source = lines.join("\n");
  const chunks = semantic.chunkSource(source, { maxChars: 600, minChars: 100 });
  assert.ok(chunks.length >= 6, `functions become separate chunks (${chunks.length})`);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 600), "no chunk is longer than the limit");
  assert.ok(chunks[0].start === 1 && chunks[chunks.length - 1].end === lines.length, "the chunks cover the whole file");
  for (let i = 1; i < chunks.length; i += 1) assert.ok(chunks[i].start === chunks[i - 1].end + 1, `chunk ${i} follows the previous one`);
  assert.ok(chunks.some((chunk) => chunk.text.startsWith("local function handler3")), "a chunk starts at a function");

  assert.deepStrictEqual(semantic.chunkSource(""), []);
  assert.deepStrictEqual(semantic.chunkSource("   \n\n"), []);
  const single = semantic.chunkSource("print('hi')");
  assert.strictEqual(single.length, 1);
  assert.deepStrictEqual([single[0].start, single[0].end], [1, 1]);

  // A minified file with one enormous line is cut into pieces.
  const huge = semantic.chunkSource(`local a = 1\n${"x".repeat(3500)}\nlocal b = 2`, { maxChars: 1000 });
  assert.ok(huge.every((chunk) => chunk.text.length <= 1000), "long lines are cut");
  assert.ok(huge.length >= 5);
  const windows = semantic.chunkSource("a\r\nb\r\nc");
  assert.strictEqual(windows[0].text, "a\nb\nc", "Windows line endings are normalized");
}

async function testEmbedding() {
  const { server, seen } = await startFakeOllama();
  const url = `http://127.0.0.1:${OLLAMA_PORT}`;
  try {
    const vectors = await semantic.embed(Array.from({ length: 40 }, (_, i) => `text number ${i} about players`), { url, model: "embeddinggemma" });
    assert.strictEqual(vectors.length, 40);
    assert.strictEqual(seen.length, 3, "inputs go out in batches of 16");
    assert.ok(seen.every((call) => call.url === "/api/embed" && call.body.model === "embeddinggemma"));
    const length = Math.sqrt(vectors[0].reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(length - 1) < 1e-5, "vectors are normalized");

    await assert.rejects(semantic.embed(["x"], { url, model: "ghost-model" }), /does not have the model ghost-model.*ollama pull ghost-model/s);
    await assert.rejects(semantic.embed(["x"], { url: "http://127.0.0.1:1", model: "m" }), /not reachable.*ollama.com.*ollama pull m/s);
    await assert.rejects(semantic.embed(["x"], { url, model: "m", fetchFn: async () => new Response(JSON.stringify({ embeddings: [] }), { status: 200 }) }), /unexpected answer/);
    await assert.rejects(semantic.embed(["x"], { url, model: "m", fetchFn: async () => new Response("boom", { status: 500 }) }), /answered 500: boom/);

    assert.ok(semantic.formatInput("embeddinggemma:latest", "query", "find x").startsWith("task: code retrieval | query: find x"));
    assert.ok(semantic.formatInput("embeddinggemma", "document", "code", "Game.Script").startsWith("title: Game.Script | text: code"));
    assert.strictEqual(semantic.formatInput("nomic-embed-text", "query", "find x"), "find x", "other models get the plain text");
  } finally {
    server.close();
  }
}

function testStore() {
  const store = new semantic.IndexStore(path.join(HOME, "unit"));
  assert.deepStrictEqual(store.list(), []);
  assert.strictEqual(store.load("1"), null);
  const vectors = [semantic.normalize([1, 0, 0]), semantic.normalize([0, 1, 0]), semantic.normalize([1, 1, 0])];
  const chunks = vectors.map((_, i) => ({ path: `Game.S${i}`, className: "Script", start: 1, end: 2, text: `t${i}` }));
  store.save("place/1", { model: "m", scripts: 3, nextOffset: null, indexedAt: "now", chunks }, vectors);
  const loaded = store.load("place/1");
  assert.ok(loaded && loaded.meta.count === 3 && loaded.meta.dim === 3 && loaded.vectors.length === 3);
  assert.ok(Math.abs(loaded.vectors[2][0] - Math.SQRT1_2) < 1e-6, "vectors survive the round trip");
  assert.deepStrictEqual(store.list(), ["place_1"], "the place id is made safe for a file name");
  const best = semantic.topMatches(loaded.vectors, semantic.normalize([1, 0.1, 0]), 2);
  assert.deepStrictEqual(best.map((hit) => hit.index), [0, 2]);
  assert.deepStrictEqual(semantic.topMatches(loaded.vectors, semantic.normalize([1, 0, 0]), 5, (i) => i !== 0).map((hit) => hit.index), [2, 1]);
  fs.writeFileSync(store.files("place/1").vec, Buffer.alloc(8));
  assert.strictEqual(store.load("place/1"), null, "a damaged vector file is treated as no index");
  assert.strictEqual(store.remove("place/1"), true);
  assert.strictEqual(store.remove("place/1"), false);
}

// --- end to end ---------------------------------------------------------------------------------------------------

const SCRIPTS = [
  { path: "game.ServerScriptService.Admin", className: "Script", source: "-- admin commands\nlocal function kickPlayer(player)\n    player:Kick('banned by the admin command')\nend\n" },
  { path: "game.ServerScriptService.Combat", className: "Script", source: "-- sword damage\nlocal function attack(humanoid)\n    humanoid.Health = humanoid.Health - 20 -- damage and health of the sword attack\nend\n" },
  { path: "game.ServerScriptService.Music", className: "Script", source: "-- play music\nlocal sound = Instance.new('Sound')\nsound.Volume = 0.5\nsound:Play() -- music sound volume\n" },
  { path: "game.ServerScriptService.Shop", className: "Script", source: "-- shop\nlocal function buyItem(player, item)\n    local price = item.Price -- coins price of the item\n    player.Coins.Value -= price\nend\n" },
  { path: "game.ServerScriptService.Teleporter", className: "Script", source: "-- teleport the player to the spawn location\nlocal function teleportPlayer(player)\n    player.Character:PivotTo(workspace.SpawnLocation.CFrame) -- teleport to spawn\nend\n" },
];

function decodeArgs(code) {
  const match = code.match(/^local args = game:GetService\("HttpService"\):JSONDecode\(("(?:[^"\\]|\\\d{3})*")\)\n([\s\S]*)$/);
  if (!match) return null;
  const literal = match[1].slice(1, -1);
  const bytes = [];
  for (let i = 0; i < literal.length; i += 1) {
    if (literal[i] === "\\") {
      bytes.push(Number(literal.slice(i + 1, i + 4)));
      i += 3;
    } else bytes.push(literal.charCodeAt(i));
  }
  return { args: JSON.parse(Buffer.from(bytes).toString("utf8")), body: match[2] };
}

// Answers the dump_scripts snippet the way the real one pages through a game.
function dumpPage(args, pageScripts = 2) {
  const offset = args.offset || 0;
  const scripts = SCRIPTS.slice(offset, offset + pageScripts);
  const next = offset + scripts.length;
  return { placeId: 4242, total: SCRIPTS.length, offset, nextOffset: next < SCRIPTS.length ? next : undefined, scripts, unreadable: 0 };
}

function connectExecutor() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    ws.on("error", reject);
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "welcome") resolve(ws);
      else if (message.type === "ping") ws.send(JSON.stringify({ type: "pong", id: message.id }));
      else if (message.type === "exec") {
        const snippet = decodeArgs(message.code);
        let value = "ran";
        if (snippet && snippet.body.includes("dump the source code of the game's scripts")) {
          value = snippet.args.root === "game.Broken" ? { error: "Not found at segment: Broken" } : dumpPage(snippet.args);
        }
        ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, value: [value] }));
      }
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", placeId: 4242, jobId: "j", userId: 1, userName: "Tester", executor: "Test", clientVersion: "9.9.9" })));
  });
}

function startMcp(extraEnv = {}) {
  const child = spawn("node", [MCP], {
    env: {
      ...process.env, SUPERBASE_CONFIG: "none", SUPERBASE_AUTOSTART: "0", SUPERBASE_UPDATE_CHECK: "0", SUPERBASE_HOME: HOME,
      SUPERBASE_PORT: String(BRIDGE_PORT), SUPERBASE_TOKEN: "", BRIDGE_TOKEN: "", BRIDGE_PORT: "",
      SUPERBASE_OLLAMA_URL: `http://127.0.0.1:${OLLAMA_PORT}`, SUPERBASE_EMBED_MODEL: "embeddinggemma", ...extraEnv,
    },
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
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 30000);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const ready = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }).then(() => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  });
  const call = async (name, args) => {
    await ready;
    return (await rpc("tools/call", { name, arguments: args })).result;
  };
  return { child, call };
}

const textOf = (result) => result.content.map((part) => part.text || "").join("\n");
// The JSON part of a tool answer (after the header line).
const bodyOf = (result) => JSON.parse(textOf(result).slice(textOf(result).indexOf("{")));

async function testEndToEnd() {
  const bridge = spawn("node", [BRIDGE], {
    env: { ...process.env, SUPERBASE_CONFIG: "none", SUPERBASE_AUTOSTART: "0", SUPERBASE_UPDATE_CHECK: "0", SUPERBASE_HOME: HOME, SUPERBASE_PORT: String(BRIDGE_PORT), SUPERBASE_TOKEN: "", BRIDGE_TOKEN: "", BRIDGE_PORT: "" },
  });
  await new Promise((resolve, reject) => {
    bridge.stdout.on("data", (data) => data.toString().includes("listening") && resolve());
    bridge.stderr.on("data", (data) => reject(new Error(data.toString())));
  });
  const ollama = await startFakeOllama();
  const mcp = startMcp();
  const executor = await connectExecutor();
  try {
    let res = await mcp.call("semantic_search", { action: "status" });
    assert.deepStrictEqual(bodyOf(res).indexes, [], "nothing is indexed at first");
    res = await mcp.call("semantic_search", { action: "search", query: "teleport" });
    assert.strictEqual(res.isError, true);
    assert.ok(/Nothing is indexed/.test(textOf(res)));
    res = await mcp.call("semantic_search", { action: "search" });
    assert.strictEqual(res.isError, true, "search needs a query");

    // Index in two calls: the first stops after max_scripts.
    res = await mcp.call("semantic_search", { action: "index", max_scripts: 2 });
    let body = bodyOf(res).value;
    assert.ok(!res.isError, textOf(res));
    assert.deepStrictEqual([body.scriptsThisCall, body.done, body.nextOffset, body.placeId], [2, false, 2, "4242"]);
    assert.ok(/offset 2/.test(body.note));
    res = await mcp.call("semantic_search", { action: "status" });
    assert.strictEqual(bodyOf(res).indexes[0].complete, false);
    // Searching a partial index works and says it is partial.
    res = await mcp.call("semantic_search", { action: "search", query: "sword damage health attack" });
    assert.strictEqual(bodyOf(res).complete, false);
    assert.strictEqual(bodyOf(res).results[0].path, "game.ServerScriptService.Combat");

    res = await mcp.call("semantic_search", { action: "index", offset: 2, max_scripts: 10 });
    body = bodyOf(res).value;
    assert.deepStrictEqual([body.scriptsIndexed, body.done, body.nextOffset], [5, true, null]);
    assert.ok(body.chunks >= 5);

    res = await mcp.call("semantic_search", { action: "search", query: "teleport the player to spawn", k: 3 });
    body = bodyOf(res);
    assert.strictEqual(body.complete, true);
    assert.strictEqual(body.results.length, 3);
    assert.strictEqual(body.results[0].path, "game.ServerScriptService.Teleporter", JSON.stringify(body.results.map((r) => r.path)));
    assert.ok(body.results[0].score >= body.results[1].score && body.results[1].score >= body.results[2].score, "best match first");
    assert.ok(/^\d+-\d+$/.test(body.results[0].lines) && body.results[0].text.includes("teleportPlayer"));
    res = await mcp.call("semantic_search", { action: "search", query: "how many coins does an item cost" });
    assert.strictEqual(bodyOf(res).results[0].path, "game.ServerScriptService.Shop");
    res = await mcp.call("semantic_search", { action: "search", query: "play sound", path_contains: "music" });
    assert.ok(bodyOf(res).results.every((hit) => hit.path.toLowerCase().includes("music")), "path_contains filters");
    assert.strictEqual(bodyOf(res).results.length, 1);
    res = await mcp.call("semantic_search", { action: "search", query: "x", place_id: "999" });
    assert.ok(res.isError && /no index for place 999/.test(textOf(res)));

    // The embeddinggemma prompt formats were used.
    assert.ok(ollama.seen.some((call) => call.body.input.some((text) => text.startsWith("title: game.ServerScriptService.Shop | text:"))));
    assert.ok(ollama.seen.some((call) => call.body.input.some((text) => text.startsWith("task: code retrieval | query:"))));

    // Continuing without an index, and a bad root, are clear errors.
    res = await mcp.call("semantic_search", { action: "clear", place_id: "4242" });
    assert.deepStrictEqual(bodyOf(res).removed, ["4242"]);
    res = await mcp.call("semantic_search", { action: "index", offset: 2 });
    assert.ok(res.isError && /Start again with offset 0/.test(textOf(res)));
    res = await mcp.call("semantic_search", { action: "index", root: "game.Broken" });
    assert.ok(res.isError && /Not found at segment: Broken/.test(textOf(res)));

    // Search and status work without the game connected.
    await mcp.call("semantic_search", { action: "index", max_scripts: 50 });
    executor.close();
    await sleep(300);
    res = await mcp.call("semantic_search", { action: "search", query: "kick ban admin" });
    assert.ok(!res.isError && bodyOf(res).results[0].path === "game.ServerScriptService.Admin", textOf(res));
    res = await mcp.call("semantic_search", { action: "index" });
    assert.ok(res.isError, "indexing needs the game");

    // A different model makes the old index unusable, and says so.
    const other = startMcp({ SUPERBASE_EMBED_MODEL: "nomic-embed-text" });
    try {
      res = await other.call("semantic_search", { action: "search", query: "teleport" });
      assert.ok(res.isError && /built with embeddinggemma but the model is now nomic-embed-text/.test(textOf(res)), textOf(res));
    } finally {
      other.child.kill();
    }
    // A model Ollama does not have.
    const ghost = startMcp({ SUPERBASE_EMBED_MODEL: "ghost-model" });
    try {
      const again = await connectExecutor();
      res = await ghost.call("semantic_search", { action: "index" });
      assert.ok(res.isError && /ollama pull ghost-model/.test(textOf(res)), textOf(res));
      again.close();
    } finally {
      ghost.child.kill();
    }

    // Ollama is not running.
    ollama.server.close();
    res = await mcp.call("semantic_search", { action: "search", query: "kick" });
    assert.ok(res.isError && /Ollama is not reachable/.test(textOf(res)), textOf(res));

    res = await mcp.call("semantic_search", { action: "clear" });
    assert.deepStrictEqual(bodyOf(res).removed, ["4242"]);
  } finally {
    mcp.child.kill();
    bridge.kill();
    try {
      ollama.server.close();
    } catch {
      // Already closed.
    }
  }
}

async function main() {
  testChunking();
  await testEmbedding();
  testStore();
  await testEndToEnd();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log("ALL SEMANTIC CHECKS PASSED");
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
