"use strict";

// Finds the autoexec folder of the executor that is connected right now, and puts the Superbase loader in it.
//
// No folder names are guessed. The connected executor is asked to write a small file with a random name
// (writefile puts it in the executor's own "workspace" folder), and Superbase searches the disk for that file.
// The folder that holds it is the workspace. From there Superbase goes up and looks for a folder whose name says
// "autoexec" (autoexec, auto-exec, AutoExecute ...). The probe file is deleted again. If any step fails, the
// folder can be given by hand (--dir).

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const background = require("./background");
const { loadSettings } = require("./config");
const { render, oneLiner, AUTOEXEC_NAME } = require("./loader");
const { isLocalHost, connectHost } = require("./config");

const AUTOEXEC_PATTERN = /auto[\s_-]?exec/i;
const WORKSPACE_PATTERN = /workspace/i;
const SKIP = new Set(["node_modules", ".git", "windows", "$recycle.bin", "system volume information", "winsxs", "proc", "sys", "dev"]);
const RECORD_FILE = "autoexec.json";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function probeName(random = crypto.randomBytes(6)) {
  return `superbase-probe-${random.toString("hex")}.txt`;
}

// The folders that are searched, the likely ones first. Existing folders only.
function searchRoots({ platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  const list = [];
  if (platform === "win32") {
    list.push(env.LOCALAPPDATA, env.APPDATA, path.join(home, "Documents"), path.join(home, "Desktop"), path.join(home, "Downloads"), home, env.ProgramData);
    for (let code = 67; code <= 90; code += 1) list.push(`${String.fromCharCode(code)}:\\`);
  } else if (platform === "darwin") {
    list.push(path.join(home, "Documents"), path.join(home, "Library", "Application Support"), path.join(home, "Downloads"), path.join(home, "Desktop"), home, "/Applications");
  } else {
    list.push(home, path.join(home, ".local", "share"));
  }
  const seen = new Set();
  return list.filter((dir) => {
    if (!dir || seen.has(dir.toLowerCase()) || !exists(dir)) return false;
    seen.add(dir.toLowerCase());
    return true;
  });
}

function entriesOf(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Looks for a file called `name` (any case) in the roots, breadth first, within a time and folder budget.
// Resolves { dir, scanned, timedOut }, with dir null when nothing was found.
function findFile(name, roots, { maxDepth = 6, maxDirs = 150000, budgetMs = 30000, now = Date.now, entries = entriesOf } = {}) {
  const wanted = name.toLowerCase();
  const deadline = now() + budgetMs;
  let scanned = 0;
  for (const root of roots) {
    let level = [root];
    for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
      const next = [];
      for (const dir of level) {
        if (now() > deadline || scanned >= maxDirs) return { dir: null, scanned, timedOut: true };
        scanned += 1;
        for (const entry of entries(dir)) {
          if (entry.isFile() && entry.name.toLowerCase() === wanted) return { dir, scanned, timedOut: false };
          if (entry.isDirectory() && !SKIP.has(entry.name.toLowerCase()) && !entry.name.startsWith("$")) next.push(path.join(dir, entry.name));
        }
      }
      level = next;
    }
  }
  return { dir: null, scanned, timedOut: false };
}

// The workspace folder: the folder that holds the probe, or the nearest parent whose name says "workspace".
function workspaceOf(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (WORKSPACE_PATTERN.test(path.basename(current))) return current;
    if (path.dirname(current) === current) return dir;
  }
}

// Folders that say "autoexec", next to the workspace or one level further up, at most two folders deep.
function findAutoexecDirs(workspace, entries = entriesOf) {
  const found = [];
  const seen = new Set([workspace.toLowerCase()]);
  const bases = [path.dirname(workspace), path.dirname(path.dirname(workspace))];
  for (const base of bases) {
    if (!base || seen.has(`base:${base.toLowerCase()}`)) continue;
    seen.add(`base:${base.toLowerCase()}`);
    let level = [base];
    for (let depth = 0; depth < 2; depth += 1) {
      const next = [];
      for (const dir of level) {
        for (const entry of entries(dir)) {
          if (!entry.isDirectory() || SKIP.has(entry.name.toLowerCase())) continue;
          const full = path.join(dir, entry.name);
          if (seen.has(full.toLowerCase())) continue;
          seen.add(full.toLowerCase());
          if (AUTOEXEC_PATTERN.test(entry.name)) found.push(full);
          else next.push(full);
        }
      }
      level = next;
    }
  }
  return found;
}

function baseUrl(settings) {
  return `http://127.0.0.1:${settings.port}`;
}

function headers(settings) {
  const result = { "x-superbase-client": "autoexec", "content-type": "application/json" };
  if (settings.token) result["x-bridge-token"] = settings.token;
  return result;
}

async function execLua(settings, code, client, timeoutMs = 15000, fetchFn = globalThis.fetch) {
  const body = { code, timeout_ms: timeoutMs };
  if (client) body.client = client;
  const response = await fetchFn(`${baseUrl(settings)}/exec`, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs + 5000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || `The bridge answered with HTTP ${response.status}.`);
  return data;
}

async function status(settings, fetchFn = globalThis.fetch) {
  const response = await fetchFn(`${baseUrl(settings)}/status`, { headers: headers(settings), signal: AbortSignal.timeout(4000) });
  if (response.status === 401) throw new Error("The bridge wants a token. Set SUPERBASE_TOKEN to the same value.");
  return response.json();
}

function recordFile(env, root) {
  return path.join(background.locations(env, root).dir, RECORD_FILE);
}

function readRecord(env, root) {
  try {
    const data = JSON.parse(fs.readFileSync(recordFile(env, root), "utf8"));
    return data && typeof data.dir === "string" ? data : null;
  } catch {
    return null;
  }
}

function writeRecord(env, root, data) {
  try {
    fs.mkdirSync(path.dirname(recordFile(env, root)), { recursive: true });
    fs.writeFileSync(recordFile(env, root), JSON.stringify(data));
  } catch {
    // The record only makes --remove easier.
  }
}

function writeLoader(dir, settings, dryRun) {
  const file = path.join(dir, AUTOEXEC_NAME);
  if (dryRun) return { file, written: false };
  fs.writeFileSync(file, render(settings.port, connectHost(settings.host), undefined, settings.token, { autoexec: true }));
  return { file, written: true };
}

const MANUAL = (command) => `Give the folder by hand: ${command}`;

// Everything that touches the outside can be replaced through `deps`, which the tests do.
async function run(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const root = deps.root;
  const out = deps.out || ((line) => console.log(line));
  const ask = deps.ask || null; // async (question) => answer, only in an interactive terminal
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const settings = { host: "127.0.0.1", ...(deps.settings || loadSettings(env, root)) };
  const dryRun = Boolean(options.dryRun);
  const manualCommand = 'npm run autoexec -- --dir "<your executor autoexec folder>"';

  // Remove: the file Superbase wrote.
  if (options.remove) {
    const dir = options.dir ? path.resolve(options.dir) : (readRecord(env, root) || {}).dir;
    if (!dir) {
      out("Nothing to remove: Superbase has no record of an autoexec folder. Give it with --dir.");
      return { ok: false, status: "no-record" };
    }
    const file = path.join(dir, AUTOEXEC_NAME);
    if (!fs.existsSync(file)) {
      out(`There is no ${AUTOEXEC_NAME} in ${dir}.`);
      return { ok: true, status: "absent", dir };
    }
    if (!dryRun) fs.unlinkSync(file);
    out(`${dryRun ? "Would remove" : "Removed"} ${file}`);
    return { ok: true, status: dryRun ? "would-remove" : "removed", dir, file };
  }

  const finish = (dir, how) => {
    const result = writeLoader(dir, settings, dryRun);
    if (!dryRun) writeRecord(env, root, { dir, file: result.file, at: new Date().toISOString() });
    out(`${dryRun ? "Would write" : "Wrote"} ${result.file}`);
    if (!dryRun) out("Your executor now runs the loader at the start of every game. It waits until the bridge answers.");
    return { ok: true, status: dryRun ? "would-write" : "written", dir, file: result.file, how };
  };

  const manual = async (reason) => {
    if (reason) out(reason);
    if (ask) {
      const answer = String(await ask("Path of the autoexec folder of your executor (empty to skip): ")).trim().replace(/^["']|["']$/g, "");
      if (answer) {
        const dir = path.resolve(answer);
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return finish(dir, "manual");
        out(`${dir} is not a folder.`);
      }
    } else {
      out(MANUAL(manualCommand));
    }
    return { ok: false, status: "manual-needed" };
  };

  // Manual folder given up front.
  if (options.dir) {
    const dir = path.resolve(options.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      out(`${dir} is not a folder.`);
      return { ok: false, status: "bad-dir" };
    }
    return finish(dir, "manual");
  }

  // The search needs a connected executor on this computer, so the bridge must run here too.
  if (!isLocalHost(settings.host)) {
    return manual(`The bridge is set to ${settings.host}, another computer, so it cannot look at the folders of this computer's executor.`);
  }

  // The search needs a connected executor, so make sure the bridge runs and a game is connected.
  const start = deps.startBridge || ((args) => background.startBridge(args));
  const started = await start({ settings, env, root });
  if (!started.ok) {
    out(`The bridge could not be started: ${started.error}`);
    return manual("");
  }

  const wait = options.waitSeconds === undefined ? 120 : options.waitSeconds;
  const pause = deps.sleep || sleep;
  const clock = deps.now || Date.now;
  let info;
  try {
    info = await status(settings, fetchFn);
    if (!info.connected && wait > 0) {
      out("Run this in your executor once, in a game, so Superbase can look at its folders:");
      out(`  ${oneLiner(settings.port, connectHost(settings.host), settings.token)}`);
      out(`Waiting up to ${wait} seconds for it to connect...`);
      const until = clock() + wait * 1000;
      while (!info.connected && clock() < until) {
        await pause(1000);
        info = await status(settings, fetchFn);
      }
    }
  } catch (error) {
    return manual(`Could not reach the bridge: ${error.message}`);
  }
  if (!info.connected) return manual("No Roblox client connected in time.");
  out(`Connected: ${info.userName || "a Roblox client"}${info.executor ? ` (${info.executor})` : ""}.`);

  // Step 1: the executor writes a file with a random name into its workspace.
  const name = (deps.probeName || probeName)();
  let answer;
  try {
    const data = await execLua(
      settings,
      `if type(writefile) ~= "function" then return { error = "This executor has no writefile." } end\nlocal ok, err = pcall(writefile, "${name}", "superbase")\nreturn { ok = ok, error = (not ok) and tostring(err) or nil }`,
      options.client,
      15000,
      fetchFn,
    );
    answer = data && data.ok && Array.isArray(data.value) ? data.value[0] : null;
    if (!answer) throw new Error((data && data.error) || "The executor did not run the command.");
    if (answer.error) throw new Error(answer.error);
  } catch (error) {
    return manual(`The executor could not write the probe file: ${error.message}`);
  }

  // Step 2: find it on the disk.
  const roots = (deps.roots || searchRoots({ platform: deps.platform, env, home: deps.home }));
  out("Looking for the probe file on this computer...");
  const hit = (deps.findFile || findFile)(name, roots, deps.search);
  let cleanup = async () => {};
  if (hit.dir) {
    const probe = path.join(hit.dir, name);
    cleanup = async () => {
      try {
        fs.unlinkSync(probe);
      } catch {
        // Fall through to the executor below.
      }
      if (fs.existsSync(probe)) {
        try {
          await execLua(settings, `pcall(function() delfile("${name}") end)`, options.client, 10000, fetchFn);
        } catch {
          // The file stays, it is a few bytes.
        }
      }
    };
  }
  if (!hit.dir) {
    return manual(hit.timedOut ? `The search ran out of time after ${hit.scanned} folders without finding the probe file.` : `The probe file was not found in the ${hit.scanned} folders that were searched. The executor may keep its files somewhere else.`);
  }

  // Step 3: from the workspace, go up and look for an autoexec folder.
  const workspace = workspaceOf(hit.dir);
  out(`Found the executor workspace: ${workspace}`);
  const candidates = findAutoexecDirs(workspace, deps.entries);
  await cleanup();
  if (candidates.length === 0) {
    return manual(`No folder that says "autoexec" was found next to the workspace.`);
  }
  if (candidates.length > 1) {
    out(`More than one autoexec folder was found, so the first one is used. Give another with --dir:`);
    candidates.forEach((dir, index) => out(`  ${index === 0 ? "*" : " "} ${dir}`));
  }
  return finish(candidates[0], "probe");
}

module.exports = { run, probeName, searchRoots, findFile, workspaceOf, findAutoexecDirs, readRecord, AUTOEXEC_PATTERN, RECORD_FILE };
