"use strict";

// npm run update: every step with a fake git, npm and GitHub.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { main } = require("../scripts/update");

const version = require("../package.json").version;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-update-script-"));
const env = { SUPERBASE_HOME: path.join(root, ".superbase"), SUPERBASE_CONFIG: "none", SUPERBASE_PORT: "19751", SUPERBASE_TOKEN: "" };

const release = (tag) => async () => ({ ok: true, status: 200, json: async () => ({ tag_name: tag, html_url: `https://example.test/${tag}` }) });
const bump = (text) => text.replace(/\d+$/, (n) => String(Number(n) + 1));
const newer = bump(version);

function capture() {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  return { text: () => lines.join(""), done: () => { process.stdout.write = original; } };
}

async function go(args, deps) {
  const out = capture();
  try {
    const code = await main(args, env, { root, ...deps });
    return { code, text: out.text() };
  } finally {
    out.done();
  }
}

(async () => {
  const calls = [];
  const fakeRun = (answers = {}) => (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const answer = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return answer ? answer[1] : { status: 0, stdout: "", stderr: "" };
  };

  // Up to date.
  let r = await go([], { fetchFn: release(`v${version}`), run: fakeRun() });
  assert.strictEqual(r.code, 0);
  assert.ok(r.text.includes("up to date"), r.text);

  // Offline or no release.
  r = await go([], { fetchFn: async () => { throw new Error("offline"); }, run: fakeRun() });
  assert.strictEqual(r.code, 1);
  assert.ok(r.text.includes("Could not find a release"), r.text);

  // A newer release, only looking.
  r = await go(["--check"], { fetchFn: release(`v${newer}`), run: fakeRun() });
  assert.strictEqual(r.code, 0);
  assert.ok(r.text.includes(`Version ${newer} is available`), r.text);
  assert.strictEqual(calls.length, 0, "--check changes nothing");

  // Not a git checkout: the installer is named and nothing is run.
  r = await go([], { fetchFn: release(`v${newer}`), run: fakeRun() });
  assert.strictEqual(r.code, 0);
  assert.ok(r.text.includes("not a git checkout") && r.text.includes("install.ps1") && r.text.includes("install.sh"), r.text);
  assert.strictEqual(calls.length, 0);

  // A git checkout.
  fs.mkdirSync(path.join(root, ".git"));

  // Local changes stop the update before anything is pulled.
  r = await go([], { fetchFn: release(`v${newer}`), run: fakeRun({ "git status": { status: 0, stdout: " M src/bridge.js\n", stderr: "" } }) });
  assert.strictEqual(r.code, 1);
  assert.ok(r.text.includes("local changes"), r.text);
  assert.ok(!calls.some((call) => call.startsWith("git pull")));

  // git is missing.
  r = await go([], { fetchFn: release(`v${newer}`), run: fakeRun({ "git status": { status: null, stdout: "", stderr: "", error: new Error("spawn git ENOENT") } }) });
  assert.strictEqual(r.code, 1);
  assert.ok(r.text.includes("git did not run") && r.text.includes("ENOENT"), r.text);

  // A pull that cannot fast-forward.
  calls.length = 0;
  r = await go([], { fetchFn: release(`v${newer}`), run: fakeRun({ "git pull": { status: 1, stdout: "", stderr: "fatal: Not possible to fast-forward" } }) });
  assert.strictEqual(r.code, 1);
  assert.ok(r.text.includes("git pull failed") && r.text.includes("fast-forward"), r.text);
  assert.ok(!calls.some((call) => call.startsWith("npm")), "npm install is not run after a failed pull");

  // npm install fails.
  r = await go([], { fetchFn: release(`v${newer}`), run: fakeRun({ "npm install": { status: 1, stdout: "", stderr: "network down" } }) });
  assert.strictEqual(r.code, 1);
  assert.ok(r.text.includes("npm install failed"), r.text);

  // Success, in the right order and with a fast-forward only pull.
  calls.length = 0;
  r = await go([], { fetchFn: release(`v${newer}`), run: fakeRun() });
  assert.strictEqual(r.code, 0);
  assert.ok(r.text.includes(`Updated to ${newer}`), r.text);
  assert.deepStrictEqual(calls.map((call) => call.split(" ").slice(0, 2).join(" ")), ["git status", "git pull", "npm install"]);
  assert.ok(calls.includes("git pull --ff-only"));
  assert.ok(calls.find((call) => call.startsWith("npm install")).includes("--omit=dev"));

  fs.rmSync(root, { recursive: true, force: true });
  console.log("ALL UPDATE SCRIPT CHECKS PASSED");
})().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
