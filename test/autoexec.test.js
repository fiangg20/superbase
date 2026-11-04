"use strict";

// The autoexec finder: a fake bridge and executor, and a fake disk in a temporary folder.

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const autoexec = require("../src/autoexec");
const { main: cli, parseArgs } = require("../scripts/autoexec");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-autoexec-"));
const home = path.join(tmp, "home");
const dirs = (...parts) => fs.mkdirSync(path.join(tmp, ...parts), { recursive: true });

// A fake bridge. `behaviour` decides what the fake executor does with the probe command.
const behaviour = { connected: true, connectAfter: 0, write: null, writefileError: null, polls: 0, token: null, codes: [], seenHeaders: [] };
const server = http.createServer((req, res) => {
  behaviour.seenHeaders.push(req.headers["x-bridge-token"] || null);
  if (behaviour.token && req.headers["x-bridge-token"] !== behaviour.token) {
    res.writeHead(401).end(JSON.stringify({ error: "token" }));
    return;
  }
  if (req.url === "/status") {
    behaviour.polls += 1;
    const connected = behaviour.connected && behaviour.polls > behaviour.connectAfter;
    res.end(JSON.stringify({ bridgeVersion: "x", connected, userName: "Tester", executor: "FakeExec 1.0" }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const { code } = JSON.parse(body);
    behaviour.codes.push(code);
    if (code.includes("writefile")) {
      const name = code.match(/pcall\(writefile, "([^"]+)"/)[1];
      if (behaviour.writefileError) return res.end(JSON.stringify({ ok: true, value: [{ error: behaviour.writefileError }] }));
      if (behaviour.write) fs.writeFileSync(path.join(behaviour.write, name), "superbase");
      return res.end(JSON.stringify({ ok: true, value: [{ ok: true }] }));
    }
    res.end(JSON.stringify({ ok: true, value: [] }));
  });
});

function setup() {
  Object.assign(behaviour, { connected: true, connectAfter: 0, write: null, writefileError: null, polls: 0, token: null, codes: [], seenHeaders: [] });
  fs.rmSync(path.join(tmp, "disk"), { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
}

function makeDeps(port, extra = {}) {
  const lines = [];
  return {
    lines,
    deps: {
      env: { SUPERBASE_HOME: home },
      settings: { port, token: "" },
      out: (line) => lines.push(line),
      startBridge: async () => ({ ok: true, started: false }),
      roots: [path.join(tmp, "disk")],
      sleep: async () => {},
      ...extra,
    },
  };
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // ---- the building blocks
  assert.ok(/^superbase-probe-[0-9a-f]{12}\.txt$/.test(autoexec.probeName()));
  assert.notStrictEqual(autoexec.probeName(), autoexec.probeName(), "probe names are random");
  for (const good of ["autoexec", "AutoExec", "auto-exec", "Auto Exec", "auto_execute", "autoexecute", "My autoexec folder"]) assert.ok(autoexec.AUTOEXEC_PATTERN.test(good), good);
  for (const bad of ["scripts", "auto", "workspace", "exec"]) assert.ok(!autoexec.AUTOEXEC_PATTERN.test(bad), bad);

  dirs("disk", "A", "workspace");
  dirs("disk", "A", "node_modules", "deep", "workspace");
  dirs("disk", "B", "x", "y", "z", "a", "b", "c", "d", "e");
  fs.writeFileSync(path.join(tmp, "disk", "A", "workspace", "Probe-File.txt"), "x");
  fs.writeFileSync(path.join(tmp, "disk", "A", "node_modules", "deep", "workspace", "hidden.txt"), "x");
  fs.writeFileSync(path.join(tmp, "disk", "B", "x", "y", "z", "a", "b", "c", "d", "e", "too-deep.txt"), "x");
  const roots = [path.join(tmp, "disk")];
  assert.strictEqual(autoexec.findFile("probe-file.txt", roots).dir, path.join(tmp, "disk", "A", "workspace"), "case does not matter");
  assert.strictEqual(autoexec.findFile("hidden.txt", roots).dir, null, "node_modules is skipped");
  assert.strictEqual(autoexec.findFile("too-deep.txt", roots, { maxDepth: 3 }).dir, null, "depth is limited");
  assert.ok(autoexec.findFile("too-deep.txt", roots, { maxDepth: 12 }).dir);
  assert.strictEqual(autoexec.findFile("nothing.txt", roots).timedOut, false);
  assert.strictEqual(autoexec.findFile("nothing.txt", roots, { maxDirs: 2 }).timedOut, true, "the folder budget stops the search");
  let tick = 0;
  assert.strictEqual(autoexec.findFile("nothing.txt", roots, { now: () => (tick += 20000), budgetMs: 30000 }).timedOut, true, "the time budget stops the search");
  assert.strictEqual(autoexec.findFile("x.txt", [path.join(tmp, "missing")]).dir, null, "a missing root is fine");

  assert.strictEqual(autoexec.workspaceOf(path.join("/a", "Exec", "workspace")), path.join("/a", "Exec", "workspace"));
  assert.strictEqual(autoexec.workspaceOf(path.join("/a", "Exec", "Workspace", "sub", "dir")), path.join("/a", "Exec", "Workspace"));
  assert.strictEqual(autoexec.workspaceOf(path.join("/a", "Exec", "files")), path.join("/a", "Exec", "files"), "no workspace in the path: the folder itself");

  const win = autoexec.searchRoots({ platform: "win32", env: { LOCALAPPDATA: "L", APPDATA: "A", ProgramData: "P" }, home: "H", exists: (dir) => ["L", "A", "H", "C:\\", "D:\\"].includes(dir) || dir.endsWith("Documents") });
  assert.deepStrictEqual(win.slice(0, 3), ["L", "A", path.join("H", "Documents")], "the likely folders come first");
  assert.ok(win.includes("C:\\") && win.includes("D:\\") && !win.includes("E:\\") && !win.includes("P"));
  assert.ok(autoexec.searchRoots({ platform: "darwin", env: {}, home: "/Users/x", exists: () => true }).includes("/Users/x/Library/Application Support"));

  // ---- the whole flow
  let state = (setup(), makeDeps(port));
  dirs("disk", "Local", "FakeExec", "workspace");
  dirs("disk", "Local", "FakeExec", "autoexec");
  dirs("disk", "Local", "Other", "scripts");
  behaviour.write = path.join(tmp, "disk", "Local", "FakeExec", "workspace");
  let result = await autoexec.run({}, state.deps);
  assert.strictEqual(result.status, "written", state.lines.join("\n"));
  const loader = path.join(tmp, "disk", "Local", "FakeExec", "autoexec", "superbase-loader.lua");
  assert.strictEqual(result.file, loader);
  const text = fs.readFileSync(loader, "utf8");
  assert.ok(text.includes(`local BRIDGE = "127.0.0.1:${port}"`) && text.includes("request"), "the loader has the right port");
  assert.ok(text.includes("local AUTOEXEC = true"), "the autoexec copy skips queue_on_teleport in the client");
  assert.deepStrictEqual(fs.readdirSync(behaviour.write), [], "the probe file is deleted");
  assert.ok(/superbase-probe-[0-9a-f]{12}\.txt/.test(behaviour.codes[0]) && behaviour.codes[0].includes('type(writefile) ~= "function"'));
  assert.strictEqual(autoexec.readRecord({ SUPERBASE_HOME: home }).dir, path.dirname(loader));
  assert.ok(state.lines.some((line) => line.includes("Found the executor workspace")));

  // Dry run writes nothing.
  fs.unlinkSync(loader);
  state = makeDeps(port);
  setup2(state);
  result = await autoexec.run({ dryRun: true }, state.deps);
  assert.strictEqual(result.status, "would-write");
  assert.ok(!fs.existsSync(loader), "a dry run writes nothing");

  // The folder name can be anything with autoexec in it, and it can be one level below the executor folder.
  fs.rmSync(path.join(tmp, "disk"), { recursive: true, force: true });
  dirs("disk", "Docs", "Exec", "bin", "workspace");
  dirs("disk", "Docs", "Exec", "Auto Execute");
  behaviour.write = path.join(tmp, "disk", "Docs", "Exec", "bin", "workspace");
  state = makeDeps(port);
  result = await autoexec.run({}, state.deps);
  assert.strictEqual(result.file, path.join(tmp, "disk", "Docs", "Exec", "Auto Execute", "superbase-loader.lua"), "found one level above the workspace folder's parent");

  // The nearest folder wins, and the others are listed.
  fs.rmSync(path.join(tmp, "disk"), { recursive: true, force: true });
  dirs("disk", "Exec", "bin", "workspace");
  dirs("disk", "Exec", "bin", "autoexec");
  dirs("disk", "Exec", "autoexec");
  behaviour.write = path.join(tmp, "disk", "Exec", "bin", "workspace");
  state = makeDeps(port);
  result = await autoexec.run({}, state.deps);
  assert.strictEqual(result.file, path.join(tmp, "disk", "Exec", "bin", "autoexec", "superbase-loader.lua"));
  assert.ok(state.lines.some((line) => line.includes("More than one autoexec folder")));

  // No autoexec folder: by hand. Not interactive, then interactive with an answer and with none.
  fs.rmSync(path.join(tmp, "disk"), { recursive: true, force: true });
  dirs("disk", "Exec", "workspace");
  const manualDir = path.join(tmp, "manual autoexec");
  fs.mkdirSync(manualDir, { recursive: true });
  behaviour.write = path.join(tmp, "disk", "Exec", "workspace");
  state = makeDeps(port);
  result = await autoexec.run({}, state.deps);
  assert.strictEqual(result.status, "manual-needed");
  assert.ok(state.lines.some((line) => line.includes("No folder that says")) && state.lines.some((line) => line.includes("--dir")));
  state = makeDeps(port, { ask: async () => `"${manualDir}"` });
  result = await autoexec.run({}, state.deps);
  assert.strictEqual(result.status, "written");
  assert.strictEqual(result.how, "manual");
  assert.ok(fs.existsSync(path.join(manualDir, "superbase-loader.lua")));
  state = makeDeps(port, { ask: async () => "" });
  assert.strictEqual((await autoexec.run({}, state.deps)).status, "manual-needed");
  state = makeDeps(port, { ask: async () => path.join(tmp, "not-a-folder") });
  assert.strictEqual((await autoexec.run({}, state.deps)).status, "manual-needed");
  assert.ok(state.lines.some((line) => line.includes("is not a folder")));

  // The probe is not found, or the executor cannot write.
  behaviour.write = null;
  state = makeDeps(port);
  result = await autoexec.run({}, state.deps);
  assert.strictEqual(result.status, "manual-needed");
  assert.ok(state.lines.some((line) => line.includes("was not found")), state.lines.join("|"));
  behaviour.writefileError = "This executor has no writefile.";
  state = makeDeps(port);
  await autoexec.run({}, state.deps);
  assert.ok(state.lines.some((line) => line.includes("no writefile")));
  behaviour.writefileError = null;

  // Waiting for the executor to connect.
  behaviour.write = path.join(tmp, "disk", "Exec", "workspace");
  fs.rmSync(path.join(manualDir, "superbase-loader.lua"), { force: true });
  dirs("disk", "Exec", "autoexec");
  behaviour.connected = true;
  behaviour.connectAfter = 3;
  behaviour.polls = 0;
  state = makeDeps(port);
  result = await autoexec.run({ waitSeconds: 30 }, state.deps);
  assert.strictEqual(result.status, "written");
  assert.ok(state.lines.some((line) => line.includes(`loadstring(game:HttpGet("http://127.0.0.1:${port}/client.lua"))()`)), "the loader line is shown while waiting");
  behaviour.connectAfter = 1000;
  behaviour.polls = 0;
  let clock = 0;
  state = makeDeps(port, { now: () => (clock += 5000) });
  result = await autoexec.run({ waitSeconds: 20 }, state.deps);
  assert.strictEqual(result.status, "manual-needed");
  assert.ok(state.lines.some((line) => line.includes("No Roblox client connected")));
  behaviour.polls = 0;
  state = makeDeps(port);
  result = await autoexec.run({ waitSeconds: 0 }, state.deps);
  assert.strictEqual(result.status, "manual-needed", "no waiting when the wait is 0");
  behaviour.connectAfter = 0;

  // The bridge cannot be started, or wants a token.
  state = makeDeps(port, { startBridge: async () => ({ ok: false, error: "port in use" }) });
  result = await autoexec.run({}, state.deps);
  assert.strictEqual(result.status, "manual-needed");
  assert.ok(state.lines[0].includes("port in use"));
  behaviour.token = "secret-token-1234567890";
  state = makeDeps(port);
  await autoexec.run({}, state.deps);
  assert.ok(state.lines.some((line) => line.includes("wants a token")));
  state = makeDeps(port, { settings: { port, token: "secret-token-1234567890" } });
  assert.strictEqual((await autoexec.run({}, state.deps)).status, "written");
  assert.ok(behaviour.seenHeaders.includes("secret-token-1234567890"), "the token is sent");
  behaviour.token = null;

  // A folder given by hand.
  const handDir = path.join(tmp, "hand");
  fs.mkdirSync(handDir);
  state = makeDeps(port);
  result = await autoexec.run({ dir: handDir }, state.deps);
  assert.strictEqual(result.status, "written");
  assert.strictEqual(behaviour.codes.length > 0, true);
  const codesBefore = behaviour.codes.length;
  await autoexec.run({ dir: handDir }, state.deps);
  assert.strictEqual(behaviour.codes.length, codesBefore, "a folder given by hand needs no executor");
  assert.strictEqual((await autoexec.run({ dir: path.join(tmp, "nope") }, state.deps)).status, "bad-dir");
  assert.strictEqual((await autoexec.run({ dir: path.join(tmp, "hand", "superbase-loader.lua") }, state.deps)).status, "bad-dir", "a file is not a folder");

  // Remove: by record, by --dir and when there is nothing.
  assert.strictEqual(autoexec.readRecord({ SUPERBASE_HOME: home }).dir, handDir);
  state = makeDeps(port);
  assert.strictEqual((await autoexec.run({ remove: true, dryRun: true }, state.deps)).status, "would-remove");
  assert.ok(fs.existsSync(path.join(handDir, "superbase-loader.lua")));
  assert.strictEqual((await autoexec.run({ remove: true }, state.deps)).status, "removed");
  assert.ok(!fs.existsSync(path.join(handDir, "superbase-loader.lua")));
  assert.strictEqual((await autoexec.run({ remove: true }, state.deps)).status, "absent");
  fs.writeFileSync(path.join(manualDir, "superbase-loader.lua"), "x");
  assert.strictEqual((await autoexec.run({ remove: true, dir: manualDir }, state.deps)).status, "removed");
  fs.rmSync(home, { recursive: true, force: true });
  assert.strictEqual((await autoexec.run({ remove: true }, makeDeps(port).deps)).status, "no-record");

  // The command line.
  assert.deepStrictEqual(parseArgs(["--dir", "x", "--wait", "5", "--client", "c2", "--dry-run"]).options, { dir: "x", remove: false, dryRun: true, waitSeconds: 5, client: "c2", help: false });
  assert.ok(parseArgs(["--wait", "abc"]).errors.length === 1);
  assert.ok(parseArgs(["--wait"]).errors.length === 1);
  assert.ok(parseArgs(["--nope"]).errors[0].includes("unknown option"));
  const lines = [];
  assert.strictEqual(await cli(["--help"], { out: (line) => lines.push(line) }), 0);
  assert.ok(lines.join("\n").includes("npm run autoexec"));
  assert.strictEqual(await cli(["--bogus"], { out: () => {} }), 2);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("ALL AUTOEXEC CHECKS PASSED");
}

// Puts the fake executor folders back after a test removed them.
function setup2() {
  dirs("disk", "Local", "FakeExec", "workspace");
  dirs("disk", "Local", "FakeExec", "autoexec");
  behaviour.write = path.join(tmp, "disk", "Local", "FakeExec", "workspace");
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  server.close();
  process.exit(1);
});
