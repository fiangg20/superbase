#!/usr/bin/env node
"use strict";

// Prints the Superbase loader for your executor.
//   npm run loader               the robust loader (works when HttpGet is blocked, retries until the bridge answers)
//   npm run loader -- --one-line the one line loadstring
// The address and token come from SUPERBASE_HOST, SUPERBASE_PORT and SUPERBASE_TOKEN (or superbase.config.json),
// or from --host, --port and --token. For a bridge on another computer, run it with --host <that computer>.

const { loadSettings, connectHost } = require("../src/config");
const { oneLiner, render } = require("../src/loader");

function main(argv, env = process.env, write = (text) => process.stdout.write(text)) {
  const settings = loadSettings(env);
  let port = settings.port;
  let host = connectHost(settings.host);
  let token = settings.token;
  let short = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--one-line") short = true;
    else if (argv[i] === "--port") {
      port = Number(argv[(i += 1)]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        process.stderr.write("--port must be a number from 1 to 65535\n");
        return 2;
      }
    } else if (argv[i] === "--host") host = String(argv[(i += 1)] || "");
    else if (argv[i] === "--token") token = String(argv[(i += 1)] || "");
    else {
      process.stderr.write(`Unknown option ${argv[i]}. Use --one-line, --port <n>, --host <address> or --token <token>.\n`);
      return 2;
    }
  }
  write(short ? `${oneLiner(port, host, token)}\n` : render(port, host, undefined, token));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
