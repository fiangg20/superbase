"use strict";

// The two ways to start the Superbase client in an executor: the one line loadstring, and roblox/loader.lua
// (which also works when HttpGet is blocked and when the bridge is not running yet).

const fs = require("fs");
const path = require("path");

const LOADER_FILE = path.join(__dirname, "..", "roblox", "loader.lua");
const AUTOEXEC_NAME = "superbase-loader.lua";

// In token mode the executor passes the token in the address, because game:HttpGet cannot send headers.
function query(token) {
  return token ? `?token=${encodeURIComponent(token)}` : "";
}

function oneLiner(port, host = "127.0.0.1", token = "") {
  return `loadstring(game:HttpGet("http://${host}:${port}/client.lua${query(token)}"))()`;
}

// roblox/loader.lua with the address of the bridge filled in.
function render(port, host = "127.0.0.1", file = LOADER_FILE, token = "") {
  const template = fs.readFileSync(file, "utf8");
  if (!/local BRIDGE = "[^"]*"/.test(template)) throw new Error("roblox/loader.lua has no BRIDGE line.");
  if (!/local TOKEN = "[^"]*"/.test(template)) throw new Error("roblox/loader.lua has no TOKEN line.");
  // encodeURIComponent leaves only characters that are safe inside a Lua string.
  return template
    .replace(/local BRIDGE = "[^"]*"/, () => `local BRIDGE = "${host}:${port}"`)
    .replace(/local TOKEN = "[^"]*"/, () => `local TOKEN = "${encodeURIComponent(token)}"`);
}

module.exports = { oneLiner, render, LOADER_FILE, AUTOEXEC_NAME };
