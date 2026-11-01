#!/usr/bin/env node
"use strict";

// Updates Superbase to the newest GitHub release: checks the release, then (when this folder is a git checkout)
// runs git pull and npm install. Without git it says how to run the installer again.
//   npm run update            update
//   npm run update -- --check only look, change nothing

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadSettings, ROOT } = require("../src/config");
const background = require("../src/background");
const updateCheck = require("../src/update-check");

const INSTALL_HINT = {
  windows: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/fiangg20/superbase/main/install.ps1 | iex"',
  unix: "curl -fsSL https://raw.githubusercontent.com/fiangg20/superbase/main/install.sh | sh",
};

function print(text) {
  process.stdout.write(`${text}\n`);
}

function defaultRun(command, args, options) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", ...options });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

// Everything that touches the outside world can be replaced, which the tests do.
async function main(args = [], env = process.env, deps = {}) {
  const run = deps.run || defaultRun;
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const root = deps.root || ROOT;
  const settings = loadSettings(env, root);
  const current = require("../package.json").version;
  const onlyCheck = args.includes("--check");

  print(`Superbase ${current}. Looking for the newest release...`);
  const cacheFile = path.join(background.locations(env, root).dir, "update.json");
  // A fresh look, not the cached answer.
  try {
    fs.unlinkSync(cacheFile);
  } catch {
    // No cache yet.
  }
  const result = await updateCheck.check({ current, cacheFile, fetchFn });
  if (!result) {
    print("Could not find a release. Either no release has been published yet, or GitHub could not be reached.");
    return 1;
  }
  if (!result.available) {
    print(`You are up to date (latest release: ${result.latest}).`);
    return 0;
  }
  print(`Version ${result.latest} is available: ${result.url}`);
  if (onlyCheck) return 0;

  if (!fs.existsSync(path.join(root, ".git"))) {
    print("This folder is not a git checkout, so it cannot update itself. Run the installer again:");
    print(`  Windows (PowerShell): ${INSTALL_HINT.windows}`);
    print(`  macOS and Linux:      ${INSTALL_HINT.unix}`);
    return 0;
  }

  const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.status !== 0) {
    print(`git did not run: ${(dirty.stderr || (dirty.error && dirty.error.message) || "unknown error").trim()}`);
    return 1;
  }
  if (dirty.stdout.trim() !== "") {
    print("There are local changes in this folder, so nothing was changed. Commit or stash them and run the update again.");
    return 1;
  }

  // The bridge keeps files open and runs old code, so it is stopped first and started again afterwards.
  const wasRunning = Boolean(await background.probe(settings.port, settings.token));
  if (wasRunning) {
    const stopped = await background.stopBridge({ settings, env, root });
    print(stopped.message);
  }

  const pull = run("git", ["pull", "--ff-only"]);
  if (pull.status !== 0) {
    print(`git pull failed: ${(pull.stderr || pull.stdout).trim()}`);
    return 1;
  }
  const install = run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"]);
  if (install.status !== 0) {
    print(`npm install failed: ${(install.stderr || install.stdout).trim()}`);
    return 1;
  }
  print(`Updated to ${result.latest}.`);
  if (wasRunning) print("The bridge was stopped for the update. It starts again by itself the next time the AI needs it (or run: npm run start:bg).");
  print("Restart your AI app so it loads the new MCP server, and run the loadstring line again in Roblox.");
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    },
  );
}

module.exports = { main };
