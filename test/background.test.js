"use strict";

// The background bridge (start, stop, state file, log) and the superbase command line.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const background = require("../src/background");
const { loadSettings } = require("../src/config");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "scripts", "superbase.js");
const PORT = 19741;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-background-"));
const env = { ...process.env, SUPERBASE_HOME: home, SUPERBASE_CONFIG: "none", SUPERBASE_PORT: String(PORT), SUPERBASE_TOKEN: "", BRIDGE_PORT: "", BRIDGE_TOKEN: "", SUPERBASE_UPDATE_CHECK: "0" };
const settings = loadSettings(env, ROOT);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// kill(pid, 0) also succeeds for a process that ended but was not collected yet (a zombie), so look at its state too.
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

const cli = (...args) => spawnSync("node", [CLI, ...args], { env, encoding: "utf8" });

async function main() {
  // Locations and state file.
  const where = background.locations(env, ROOT);
  assert.strictEqual(where.dir, home);
  assert.strictEqual(path.basename(where.state), "bridge.json");
  assert.strictEqual(path.basename(where.log), "bridge.log");
  assert.strictEqual(background.readState(env, ROOT), null);
  background.writeState(env, ROOT, { pid: 123, port: 1 });
  assert.strictEqual(background.readState(env, ROOT).pid, 123);
  background.clearState(env, ROOT, 999);
  assert.ok(background.readState(env, ROOT), "another process's state is not removed");
  background.clearState(env, ROOT, 123);
  assert.strictEqual(background.readState(env, ROOT), null);
  fs.writeFileSync(where.state, "{{{");
  assert.strictEqual(background.readState(env, ROOT), null, "a damaged state file is ignored");
  fs.rmSync(where.state);

  // The log tail.
  fs.writeFileSync(where.log, "a\nb\n\nc\nd\n");
  assert.deepStrictEqual(background.tailLines(where.log, 2), ["c", "d"]);
  assert.deepStrictEqual(background.tailLines(path.join(home, "missing.log"), 2), []);
  fs.rmSync(where.log);

  // Nothing runs yet.
  assert.strictEqual(await background.probe(PORT, ""), null);
  let result = await background.stopBridge({ settings, env, root: ROOT });
  assert.ok(result.ok && result.stopped === false, "stopping when nothing runs is fine");
  assert.strictEqual(cli("status").stdout.includes("not running"), true);
  assert.strictEqual(cli("stop").status, 0);

  // A spawn that fails, and a process that dies at once, are reported with the reason.
  result = await background.startBridge({ settings, env, root: ROOT, spawnFn: () => { throw new Error("no node here"); } });
  assert.deepStrictEqual({ ok: result.ok, started: result.started }, { ok: false, started: false });
  assert.ok(result.error.includes("no node here"), result.error);
  const dying = path.join(home, "dies.js");
  fs.writeFileSync(dying, 'console.error("port is taken"); process.exit(3);');
  result = await background.startBridge({ settings, env, root: ROOT, bridgeFile: dying, waitMs: 4000 });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes("port is taken") && result.error.includes(where.log), result.error);
  const fake = new EventEmitter();
  fake.unref = () => {};
  result = await background.startBridge({ settings, env, root: ROOT, spawnFn: () => fake, waitMs: 300 });
  assert.ok(!result.ok && result.error.includes("did not start"), "a bridge that never answers times out");

  // A real start with the command line.
  let run = cli("start");
  assert.strictEqual(run.status, 0, run.stderr + run.stdout);
  assert.ok(run.stdout.includes("Started the bridge in the background"), run.stdout);
  const state = background.readState(env, ROOT);
  assert.ok(state && state.pid > 0 && state.port === PORT, JSON.stringify(state));
  const status = await background.probe(PORT, "");
  assert.strictEqual(status.bridgePid, state.pid, "the status reports the same process");
  assert.ok(fs.readFileSync(where.log, "utf8").includes("starting the bridge"));

  // Starting twice is harmless.
  run = cli("start");
  assert.strictEqual(run.status, 0);
  assert.ok(run.stdout.includes("already running"), run.stdout);
  assert.strictEqual(background.readState(env, ROOT).pid, state.pid);

  // status and logs.
  run = cli("status");
  assert.ok(run.stdout.includes(`running on port ${PORT}`) && run.stdout.includes("No Roblox client"), run.stdout);
  run = cli("logs", "-n", "3");
  assert.strictEqual(run.status, 0);
  assert.ok(run.stdout.trim().split("\n").length <= 3);
  assert.notStrictEqual(cli("logs", "-n", "zero").status, 0);
  assert.notStrictEqual(cli("logs", "--bogus").status, 0);

  // restart gives a new process.
  run = cli("restart");
  assert.strictEqual(run.status, 0, run.stderr + run.stdout);
  const second = background.readState(env, ROOT);
  assert.ok(second.pid !== state.pid, "restart starts a new process");
  assert.ok(!alive(state.pid), "the old process is gone");

  // A bridge that was not started by Superbase is still found by its port, and stopping checks it really is a bridge.
  run = cli("stop");
  assert.strictEqual(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes("Stopped the bridge"), run.stdout);
  assert.strictEqual(await background.probe(PORT, ""), null);
  assert.strictEqual(background.readState(env, ROOT), null, "the state file is removed");
  assert.ok(!alive(second.pid), "the stopped process is gone");

  // A token: the wrong one is reported, not killed.
  const tokenEnv = { ...env, SUPERBASE_TOKEN: "background-test-token-123456" };
  const tokenSettings = loadSettings(tokenEnv, ROOT);
  result = await background.startBridge({ settings: tokenSettings, env: tokenEnv, root: ROOT });
  assert.ok(result.ok && result.started);
  result = await background.startBridge({ settings, env, root: ROOT });
  assert.ok(!result.ok && result.error.includes("different token"), result.error);
  result = await background.stopBridge({ settings, env, root: ROOT });
  assert.ok(!result.ok && result.message.includes("token"), result.message);
  result = await background.stopBridge({ settings: tokenSettings, env: tokenEnv, root: ROOT });
  assert.ok(result.ok && result.stopped, result.message);

  // Another program on the port is not mistaken for a bridge, and is never killed.
  const http = require("http");
  const other = http.createServer((req, res) => res.end("hello")).listen(PORT);
  await new Promise((resolve) => other.once("listening", resolve));
  assert.strictEqual(await background.probe(PORT, ""), null);
  result = await background.stopBridge({ settings, env, root: ROOT });
  assert.ok(result.ok && !result.stopped);
  other.close();
  await sleep(100);

  // Unknown commands and help.
  run = cli("dance");
  assert.notStrictEqual(run.status, 0);
  assert.ok(run.stderr.includes("Unknown command"));
  assert.ok(cli("help").stdout.includes("Usage: superbase"));

  fs.rmSync(home, { recursive: true, force: true });
  console.log("ALL BACKGROUND CHECKS PASSED");
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  try {
    const state = background.readState(env, ROOT);
    if (state) process.kill(state.pid);
  } catch {
    // Nothing left to stop.
  }
  process.exit(1);
});
