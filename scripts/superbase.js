#!/usr/bin/env node
"use strict";

// The Superbase command line: run the bridge in the background and look after it.
//   superbase                 run the bridge in this terminal (same as npm start)
//   superbase start           start the bridge in the background
//   superbase stop            stop the background bridge
//   superbase restart         stop it and start it again
//   superbase status          show whether the bridge runs and what is connected
//   superbase logs [-n 50] [--follow]
//   superbase update          update Superbase to the newest release
// The MCP server also starts the bridge by itself when the AI needs it, so most people never need this.

const fs = require("fs");
const path = require("path");
const { loadSettings } = require("../src/config");
const background = require("../src/background");

const HELP = `Superbase ${require("../package.json").version}

Usage: superbase [command]

  (no command)       run the bridge in this terminal
  start              start the bridge in the background
  stop               stop the background bridge
  restart            stop it and start it again
  status             show whether the bridge runs and what is connected
  logs [-n N] [-f]   show the last N lines of the bridge log (default 40), -f keeps following it
  update             update Superbase to the newest release
  help               show this text
`;

function print(text) {
  process.stdout.write(`${text}\n`);
}

function fail(text) {
  process.stderr.write(`${text}\n`);
  return 1;
}

function parseLogArgs(args) {
  const options = { lines: 40, follow: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-f" || arg === "--follow") options.follow = true;
    else if (arg === "-n" || arg === "--lines") {
      const value = Number(args[i + 1]);
      if (!Number.isInteger(value) || value < 1) return { error: `${arg} needs a number, for example ${arg} 100.` };
      options.lines = Math.min(value, 5000);
      i += 1;
    } else return { error: `Unknown option '${arg}'. Use -n N or --follow.` };
  }
  return options;
}

async function status(settings, env) {
  const info = await background.probe(settings.port, settings.token);
  if (!info) {
    print(`The bridge is not running on port ${settings.port}.`);
    return 0;
  }
  if (info.unauthorized) {
    print(`A bridge runs on port ${settings.port}, but it wants a token. Set SUPERBASE_TOKEN to the same value.`);
    return 0;
  }
  const clients = Array.isArray(info.clients) ? info.clients : [];
  print(`The bridge is running on port ${settings.port} (version ${info.bridgeVersion}${info.bridgePid ? `, process ${info.bridgePid}` : ""}).`);
  if (clients.length === 0) print("No Roblox client is connected.");
  for (const client of clients) {
    print(`  ${client.id}  ${client.userName || "unknown player"}${client.executor ? `  ${client.executor}` : ""}${client.placeId ? `  place ${client.placeId}` : ""}`);
  }
  if (info.update && info.update.available) print(`Version ${info.update.latest} is available. Run: superbase update`);
  print(`Log file: ${background.locations(env).log}`);
  return 0;
}

async function showLogs(env, args) {
  const options = parseLogArgs(args);
  if (options.error) return fail(options.error);
  const file = background.locations(env).log;
  if (!fs.existsSync(file)) return fail(`There is no log yet (${file}). Start the bridge in the background first: superbase start`);

  for (const line of background.tailLines(file, options.lines)) print(line);
  if (!options.follow) return 0;

  let position = fs.statSync(file).size;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      try {
        const size = fs.statSync(file).size;
        if (size < position) position = 0; // The log was cut down at a start.
        if (size > position) {
          const fd = fs.openSync(file, "r");
          const buffer = Buffer.alloc(size - position);
          fs.readSync(fd, buffer, 0, buffer.length, position);
          fs.closeSync(fd);
          process.stdout.write(buffer.toString("utf8"));
          position = size;
        }
      } catch {
        // The file may be rewritten at this moment.
      }
    }, 500);
    process.on("SIGINT", () => {
      clearInterval(timer);
      resolve();
    });
  });
  return 0;
}

async function main(argv, env = process.env) {
  const [command = "run", ...rest] = argv;
  const settings = loadSettings(env);

  switch (command) {
    case "run":
    case "foreground":
      require("../src/bridge");
      return null; // The bridge keeps the process alive.
    case "start": {
      const result = await background.startBridge({ settings, env });
      if (!result.ok) return fail(result.error);
      print(result.started ? `Started the bridge in the background (process ${result.pid}, port ${settings.port}).` : "The bridge is already running.");
      print(`Log file: ${background.locations(env).log}`);
      return 0;
    }
    case "stop": {
      const result = await background.stopBridge({ settings, env });
      if (!result.ok) return fail(result.message);
      print(result.message);
      return 0;
    }
    case "restart": {
      const stopped = await background.stopBridge({ settings, env });
      if (!stopped.ok) return fail(stopped.message);
      const result = await background.startBridge({ settings, env });
      if (!result.ok) return fail(result.error);
      print(`Restarted the bridge (process ${result.pid}, port ${settings.port}).`);
      return 0;
    }
    case "status":
      return status(settings, env);
    case "logs":
      return showLogs(env, rest);
    case "update":
      return require("./update").main(rest, env);
    case "help":
    case "--help":
    case "-h":
      print(HELP);
      return 0;
    default:
      return fail(`Unknown command '${command}'.\n\n${HELP}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== null) process.exit(code);
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    },
  );
}

module.exports = { main, parseLogArgs };
