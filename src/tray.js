"use strict";

// The tray icon of the background bridge (Windows only). It starts src/tray.ps1 in a hidden PowerShell, which shows
// the Superbase icon with a menu (dashboard, loader line, log, restart, stop). The bridge starts it when it runs
// in the background, so people do not need npm run stop, status and logs. Everything that touches the system can be
// replaced through `deps`, which the tests do.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { connectHost, ROOT } = require("./config");

const SCRIPT_FILE = path.join(__dirname, "tray.ps1");
const ICON_FILE = path.join(ROOT, "assets", "icon.png");
const CLI_FILE = path.join(ROOT, "scripts", "superbase.js");

// Files from a downloaded ZIP carry a "this came from the internet" mark that makes PowerShell refuse them under
// RemoteSigned. Removing it from our own script is what Unblock-File does.
function unblock(file) {
  try {
    fs.unlinkSync(`${file}:Zone.Identifier`);
  } catch {
    // There was no mark.
  }
}

function trayArguments({ script, settings, version, pid, execPath, cliFile, logFile, iconFile }) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-ExecutionPolicy",
    "RemoteSigned",
    "-File",
    script,
    "-Port",
    String(settings.port),
    "-BridgeHost",
    connectHost(settings.host),
    "-BridgePid",
    String(pid),
    "-Version",
    version,
    "-NodePath",
    execPath,
    "-CliPath",
    cliFile,
    "-LogFile",
    logFile,
  ];
  if (iconFile) args.push("-IconFile", iconFile);
  return args;
}

// Returns { started: true, stop() } or { started: false, reason }.
function start(options, deps = {}) {
  const platform = deps.platform || process.platform;
  const spawnFn = deps.spawnFn || spawn;
  const exists = deps.exists || fs.existsSync;
  const log = deps.log || (() => {});
  const { settings, version, logFile } = options;

  if (platform !== "win32") return { started: false, reason: "The tray icon is only available on Windows." };
  if (settings.tray === false) return { started: false, reason: "The tray icon is turned off (tray: false)." };
  const script = deps.script || SCRIPT_FILE;
  if (!exists(script)) return { started: false, reason: `${script} is missing.` };
  (deps.unblock || unblock)(script);

  const iconFile = deps.iconFile || ICON_FILE;
  const args = trayArguments({
    script,
    settings,
    version,
    pid: deps.pid || process.pid,
    execPath: deps.execPath || process.execPath,
    cliFile: deps.cliFile || CLI_FILE,
    logFile,
    iconFile: exists(iconFile) ? iconFile : "",
  });

  // The token goes in the environment of the tray process, not on a command line that other programs can list.
  const env = { ...(deps.env || process.env) };
  if (settings.token) env.SUPERBASE_TRAY_TOKEN = settings.token;
  else delete env.SUPERBASE_TRAY_TOKEN;

  let child;
  try {
    child = spawnFn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env });
  } catch (error) {
    return { started: false, reason: `Could not start PowerShell: ${error.message}` };
  }

  let errors = "";
  const startedAt = Date.now();
  if (child.stderr && typeof child.stderr.on === "function") {
    child.stderr.on("data", (chunk) => {
      if (errors.length < 400) errors += String(chunk);
    });
  }
  let stopping = false;
  child.on("error", (error) => log(`tray: could not run PowerShell (${error.message}).`));
  child.on("exit", (code) => {
    // The menu closes the icon by itself with code 0. Anything else, soon after the start, is worth a line in the log.
    if (!stopping && code !== 0 && code !== null) {
      const detail = errors.replace(/\s+/g, " ").trim().slice(0, 240);
      log(`tray: PowerShell ended with code ${code} after ${Math.round((Date.now() - startedAt) / 1000)} s${detail ? `: ${detail}` : ""}. The bridge keeps running without the tray icon.`);
    }
  });

  return {
    started: true,
    child,
    stop() {
      stopping = true;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    },
  };
}

module.exports = { start, trayArguments, unblock, SCRIPT_FILE, ICON_FILE };
