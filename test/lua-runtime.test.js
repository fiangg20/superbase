"use strict";

// Runs the Lua snippets in src/lua against a small mock of the Roblox API (test/lua), using any
// plain Lua 5.3 or newer found on this computer. It checks the logic of the snippets: selectors,
// filters, formatting, argument handling. It does not replace a test in a real executor.
// When no Lua interpreter is installed the test is skipped, not failed.

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CASES = path.join(__dirname, "lua", "cases.lua");
const CANDIDATES = ["lua5.4", "lua5.3", "lua54", "lua53", "lua", "texlua"];

function findLua() {
  const probeFile = path.join(__dirname, "lua", "version.lua");
  for (const name of CANDIDATES) {
    const probe = spawnSync(name, [probeFile], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return name;
  }
  return null;
}

const lua = findLua();
if (!lua) {
  console.log("LUA RUNTIME CHECKS SKIPPED (no Lua 5.3 or newer interpreter found; install lua5.4 to run them)");
  process.exit(0);
}

const result = spawnSync(lua, [CASES], {
  cwd: ROOT,
  encoding: "utf8",
  env: { ...process.env, SUPERBASE_LUA_DIR: path.join(ROOT, "src", "lua") },
});

const output = `${result.stdout || ""}${result.stderr || ""}`;
if (result.status !== 0) {
  console.error(output);
  console.error(`LUA RUNTIME CHECKS FAILED (interpreter: ${lua})`);
  process.exit(1);
}

const summary = output.trim().split("\n").pop();
console.log(`ALL LUA RUNTIME CHECKS PASSED with ${lua} (${summary.trim()})`);
