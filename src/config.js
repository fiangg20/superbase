"use strict";

// Settings for the bridge and the MCP server. They come from three places, in this order:
//   1. environment variables (SUPERBASE_PORT and so on)
//   2. superbase.config.json in the Superbase folder (or the file named by SUPERBASE_CONFIG)
//   3. the defaults
// SUPERBASE_CONFIG=none ignores the file. A problem in the file never stops anything: it is reported
// in `warnings` and the value falls back to the default.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_PORT = 9731;

// key: [type, check, env variables, default]
const SPEC = {
  port: ["integer", (v) => v >= 1 && v <= 65535, ["SUPERBASE_PORT", "BRIDGE_PORT"], DEFAULT_PORT],
  token: ["string", () => true, ["SUPERBASE_TOKEN", "BRIDGE_TOKEN"], ""],
  clientUrl: ["string", () => true, ["SUPERBASE_CLIENT_URL"], ""],
  pingMs: ["integer", (v) => v >= 50, ["SUPERBASE_PING_MS"], 10000],
  staleMs: ["integer", (v) => v >= 100, ["SUPERBASE_STALE_MS"], 30000],
  autostart: ["boolean", () => true, ["SUPERBASE_AUTOSTART"], true],
  updateCheck: ["boolean", () => true, ["SUPERBASE_UPDATE_CHECK"], true],
  plain: ["boolean", () => true, ["SUPERBASE_PLAIN"], false],
  recipesDir: ["string", () => true, ["SUPERBASE_RECIPES"], ""],
  screenshotMaxWidth: ["integer", (v) => v >= 320 && v <= 1920, ["SUPERBASE_SCREENSHOT_WIDTH"], 1280],
  screenshotFocus: ["boolean", () => true, ["SUPERBASE_SCREENSHOT_FOCUS"], true],
};

function parseValue(type, raw) {
  if (type === "string") return typeof raw === "string" ? raw : undefined;
  if (type === "integer") {
    const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    return Number.isInteger(number) ? number : undefined;
  }
  if (type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      if (/^(0|false|off|no)$/i.test(raw.trim())) return false;
      if (/^(1|true|on|yes)$/i.test(raw.trim())) return true;
    }
  }
  return undefined;
}

function configPath(env, root) {
  const named = env.SUPERBASE_CONFIG;
  if (named && /^(none|off)$/i.test(named)) return null;
  return named ? path.resolve(named) : path.join(root, "superbase.config.json");
}

function readFile(file, warnings) {
  if (!file || !fs.existsSync(file)) return {};
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    warnings.push(`${path.basename(file)} is not valid JSON (${error.message}), so it was ignored.`);
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    warnings.push(`${path.basename(file)} must contain a JSON object, so it was ignored.`);
    return {};
  }
  return data;
}

// Returns the settings plus where each value came from, the config file that was read and any warnings.
function loadSettings(env = process.env, root = ROOT) {
  const warnings = [];
  const file = configPath(env, root);
  const fromFile = readFile(file, warnings);
  const settings = {};
  const sources = {};

  for (const key of Object.keys(fromFile)) {
    if (!(key in SPEC) && key !== "$schema" && !key.startsWith("_")) {
      warnings.push(`Unknown setting "${key}" in ${path.basename(file)}. Known settings: ${Object.keys(SPEC).join(", ")}.`);
    }
  }

  for (const [key, [type, valid, envNames, fallback]] of Object.entries(SPEC)) {
    let chosen;
    for (const name of envNames) {
      const raw = env[name];
      if (raw === undefined || raw === "") continue;
      const value = parseValue(type, raw);
      if (value !== undefined && valid(value)) {
        chosen = { value, source: "env" };
        break;
      }
      warnings.push(`${name}=${raw} is not a valid ${key}, so it was ignored.`);
    }
    if (!chosen && key in fromFile) {
      const value = parseValue(type, fromFile[key]);
      if (value !== undefined && valid(value)) chosen = { value, source: "file" };
      else warnings.push(`"${key}" in ${path.basename(file)} is not valid (${JSON.stringify(fromFile[key])}), so the default is used.`);
    }
    settings[key] = chosen ? chosen.value : fallback;
    sources[key] = chosen ? chosen.source : "default";
  }

  if (settings.token !== "" && settings.token.length < 16) {
    // The bridge refuses to start with a short token and says so, this only explains where it came from.
    warnings.push(`The token (from ${sources.token}) is shorter than 16 characters.`);
  }
  return { ...settings, sources, file: file && fs.existsSync(file) ? file : null, warnings };
}

// Where the background bridge keeps its state file and log.
function stateDir(env = process.env, root = ROOT) {
  return env.SUPERBASE_HOME ? path.resolve(env.SUPERBASE_HOME) : path.join(root, ".superbase");
}

module.exports = { loadSettings, stateDir, configPath, SPEC, ROOT, DEFAULT_PORT };
