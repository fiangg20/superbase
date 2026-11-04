"use strict";

// Runs the bridge in the background, so nobody has to keep a terminal open for it. Used by the MCP server (it
// starts the bridge when the AI needs it) and by scripts/superbase.js (start, stop, status, logs).
// The bridge writes its process id and port to a state file, and its output goes to a log file, both in the
// state folder (see config.stateDir).

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { stateDir, ROOT } = require("./config");

const BRIDGE_FILE = path.join(__dirname, "bridge.js");
const MAX_LOG_BYTES = 512 * 1024;

function locations(env = process.env, root = ROOT) {
  const dir = stateDir(env, root);
  return { dir, state: path.join(dir, "bridge.json"), log: path.join(dir, "bridge.log") };
}

function readState(env, root) {
  try {
    const data = JSON.parse(fs.readFileSync(locations(env, root).state, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

// Called by the bridge when it is listening.
function writeState(env, root, data) {
  const { dir, state } = locations(env, root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(state, JSON.stringify(data, null, 2));
}

// Called by the bridge when it exits. Only removes the file when it still belongs to this process.
function clearState(env, root, pid) {
  try {
    const current = readState(env, root);
    if (current && current.pid === pid) fs.unlinkSync(locations(env, root).state);
  } catch {
    // Nothing to remove.
  }
}

// Asks a bridge on this port for its status. Returns the status object, or null when nothing answered.
async function probe(port, token, timeoutMs = 1500) {
  try {
    const headers = { "x-superbase-client": "background" };
    if (token) headers["x-bridge-token"] = token;
    const response = await fetch(`http://127.0.0.1:${port}/status`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401) return { unauthorized: true };
    if (!response.ok) return null;
    const data = await response.json();
    return data && typeof data === "object" && "bridgeVersion" in data ? data : null;
  } catch {
    return null;
  }
}

function tailLines(file, count) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-count);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Starts the bridge as a detached process and waits until it answers. Resolves { ok, started, pid, error }.
// `bridgeFile`, `spawnFn` and `waitMs` can be replaced, which the tests do.
async function startBridge({ settings, env = process.env, root = ROOT, bridgeFile = BRIDGE_FILE, spawnFn = spawn, waitMs = 8000 }) {
  const existing = await probe(settings.port, settings.token);
  if (existing && existing.unauthorized) {
    return { ok: false, started: false, error: "A bridge is already running on this port, but it wants a different token." };
  }
  if (existing) return { ok: true, started: false, pid: existing.bridgePid || null };

  const { dir, log } = locations(env, root);
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.statSync(log).size > MAX_LOG_BYTES) fs.writeFileSync(log, "");
  } catch {
    // No log yet.
  }
  const fd = fs.openSync(log, "a");
  fs.writeSync(fd, `\n--- starting the bridge ${new Date().toISOString()} ---\n`);

  let child;
  let exited = null;
  try {
    child = spawnFn(process.execPath, [bridgeFile], {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: { ...env, SUPERBASE_PLAIN: "1", SUPERBASE_BACKGROUND: "1", SUPERBASE_PORT: String(settings.port) },
    });
    child.on("exit", (code) => {
      exited = code === null ? "stopped" : code;
    });
    child.on("error", (error) => {
      exited = error.message;
    });
    child.unref();
  } catch (error) {
    fs.closeSync(fd);
    return { ok: false, started: false, error: `Could not start the bridge: ${error.message}` };
  }
  fs.closeSync(fd);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(150);
    const status = await probe(settings.port, settings.token, 800);
    if (status && !status.unauthorized) return { ok: true, started: true, pid: child.pid };
    if (exited !== null) break;
  }
  const reason = tailLines(log, 3).join(" | ") || (exited !== null ? `the process ended (${exited})` : "it did not answer in time");
  return { ok: false, started: false, error: `The bridge did not start: ${reason}. Full log: ${log}` };
}

// Stops the bridge that wrote the state file. It checks that the process on that port really is the bridge.
async function stopBridge({ settings, env = process.env, root = ROOT }) {
  const state = readState(env, root);
  const port = (state && state.port) || settings.port;
  const status = await probe(port, settings.token);
  if (!status) {
    if (state) clearState(env, root, state.pid);
    return { ok: true, stopped: false, message: "No bridge is running." };
  }
  if (status.unauthorized) return { ok: false, stopped: false, message: "The bridge wants a token. Set the same token and try again." };
  const pid = status.bridgePid || (state && state.pid);
  if (!pid) return { ok: false, stopped: false, message: "The bridge is running, but it did not report its process id (an older version). Close it by hand." };
  try {
    process.kill(pid);
  } catch (error) {
    return { ok: false, stopped: false, message: `Could not stop process ${pid}: ${error.message}` };
  }
  for (let i = 0; i < 20; i += 1) {
    await sleep(150);
    if (!(await probe(port, settings.token, 500))) {
      clearState(env, root, pid);
      return { ok: true, stopped: true, pid, message: `Stopped the bridge (process ${pid}).` };
    }
  }
  return { ok: false, stopped: false, pid, message: `Process ${pid} did not stop in time.` };
}

module.exports = { locations, readState, writeState, clearState, probe, tailLines, startBridge, stopBridge, BRIDGE_FILE };
