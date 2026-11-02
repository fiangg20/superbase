#!/usr/bin/env node
"use strict";

// Puts the Superbase loader in the autoexec folder of your executor, so it starts by itself in every game.
//   npm run autoexec                      find the folder (needs the executor connected) and write the loader
//   npm run autoexec -- --dir <folder>    write it into a folder you name
//   npm run autoexec -- --remove          take it out again
// Options: --dry-run, --wait <seconds> (how long to wait for the executor, default 120), --client <id>.

const readline = require("readline");
const autoexec = require("../src/autoexec");

const HELP = `Superbase autoexec

  npm run autoexec                      find the autoexec folder of the connected executor and write the loader
  npm run autoexec -- --dir <folder>    write it into a folder you name
  npm run autoexec -- --remove          remove the loader again (--dir if Superbase does not know the folder)

Options
  --dry-run          show what would happen and write nothing
  --wait <seconds>   how long to wait for the executor to connect (default 120)
  --client <id>      use this client when several Roblox windows are connected
  --help             this text`;

function parseArgs(argv) {
  const options = { dir: null, remove: false, dryRun: false, waitSeconds: undefined, client: undefined, help: false };
  const errors = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) errors.push(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--dir") options.dir = value();
    else if (arg === "--remove") options.remove = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--client") options.client = value();
    else if (arg === "--wait") {
      const raw = value();
      if (raw === undefined) continue;
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) errors.push("--wait must be a number of seconds from 0 to 3600");
      else options.waitSeconds = seconds;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else errors.push(`unknown option ${arg}`);
  }
  return { options, errors };
}

async function main(argv, deps = {}) {
  const out = deps.out || ((line) => console.log(line));
  const { options, errors } = parseArgs(argv);
  if (errors.length) {
    errors.forEach((message) => out(`Error: ${message}`));
    out("Run with --help to see the options.");
    return 2;
  }
  if (options.help) {
    out(HELP);
    return 0;
  }

  let rl = null;
  let ask = deps.ask || null;
  if (!ask && process.stdin.isTTY && !options.dir && !options.remove) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  }
  try {
    const result = await autoexec.run(options, { ...deps, out, ask });
    return result.ok ? 0 : 1;
  } finally {
    if (rl) rl.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    },
  );
}

module.exports = { main, parseArgs };
