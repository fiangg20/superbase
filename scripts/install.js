#!/usr/bin/env node
"use strict";

// Registers the Superbase MCP server in the AI clients installed on this computer, so nobody has to edit
// their config files by hand. No dependencies. Every file is backed up before it changes, nothing is
// written without a confirmation (or --yes), and --uninstall takes the entry out again.
//
//   node scripts/install.js            show what was found and ask
//   node scripts/install.js --yes      register in every client that was found
//   node scripts/install.js --list     only show what was found
//   node scripts/install.js --dry-run  show what would change, write nothing
//   node scripts/install.js --uninstall
//
// Options: --client a,b  --file <path> [--key mcpServers] [--shape standard|vscode|opencode]
//          --port <n>  --node <command>  --print  --help

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const { supportsUnicode, makeUi, banner, shorten } = require("../src/terminal");

const ROOT = path.join(__dirname, "..");
const SERVER_FILE = path.join(ROOT, "src", "mcp-server.js");
const NAME = "superbase";

// ---------------------------------------------------------------------------
// Where each client keeps its MCP servers
// ---------------------------------------------------------------------------

// kind "json": a JSON file with a key that holds the servers. kind "toml": Codex. kind "cli": Claude Code,
// which has its own command for it.
// shape "standard": { command, args, env }. "vscode": adds type "stdio". "opencode": a command array.
function buildClients(ctx) {
  const { platform, home, env } = ctx;
  const join = path.join;
  const appData = env.APPDATA || join(home, "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, ".config");

  // Where VS Code style editors keep their user data.
  const editorUser = (name) => {
    if (platform === "win32") return join(appData, name, "User");
    if (platform === "darwin") return join(home, "Library", "Application Support", name, "User");
    return join(xdgConfig, name, "User");
  };

  // Claude Desktop from the Microsoft Store keeps its data in a package folder.
  const claudeDesktopFiles = [];
  if (platform === "win32") {
    claudeDesktopFiles.push(join(appData, "Claude", "claude_desktop_config.json"));
    try {
      const packages = join(localAppData, "Packages");
      for (const entry of fs.readdirSync(packages)) {
        if (entry.startsWith("Claude_")) claudeDesktopFiles.push(join(packages, entry, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
      }
    } catch { /* no packages folder */ }
  } else if (platform === "darwin") {
    claudeDesktopFiles.push(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
  } else {
    claudeDesktopFiles.push(join(xdgConfig, "Claude", "claude_desktop_config.json"));
  }

  const extensionSettings = (extension, file) => join(editorUser("Code"), "globalStorage", extension, "settings", file);
  const codexHome = env.CODEX_HOME || join(home, ".codex");

  return [
    { id: "claude-desktop", label: "Claude Desktop", kind: "json", key: "mcpServers", shape: "standard", files: claudeDesktopFiles, dirs: claudeDesktopFiles.map((file) => path.dirname(file)) },
    { id: "claude-code", label: "Claude Code", kind: "cli", commands: ["claude"] },
    { id: "cursor", label: "Cursor", kind: "json", key: "mcpServers", shape: "standard", files: [join(home, ".cursor", "mcp.json")], dirs: [join(home, ".cursor")] },
    { id: "windsurf", label: "Windsurf", kind: "json", key: "mcpServers", shape: "standard", files: [join(home, ".codeium", "windsurf", "mcp_config.json")], dirs: [join(home, ".codeium", "windsurf")] },
    { id: "vscode", label: "VS Code", kind: "json", key: "servers", shape: "vscode", files: [join(editorUser("Code"), "mcp.json")], dirs: [editorUser("Code")] },
    { id: "vscode-insiders", label: "VS Code Insiders", kind: "json", key: "servers", shape: "vscode", files: [join(editorUser("Code - Insiders"), "mcp.json")], dirs: [editorUser("Code - Insiders")] },
    { id: "cline", label: "Cline", kind: "json", key: "mcpServers", shape: "standard", files: [extensionSettings("saoudrizwan.claude-dev", "cline_mcp_settings.json")], dirs: [join(editorUser("Code"), "globalStorage", "saoudrizwan.claude-dev")] },
    { id: "roo-code", label: "Roo Code", kind: "json", key: "mcpServers", shape: "standard", files: [extensionSettings("rooveterinaryinc.roo-cline", "mcp_settings.json")], dirs: [join(editorUser("Code"), "globalStorage", "rooveterinaryinc.roo-cline")] },
    { id: "gemini-cli", label: "Gemini CLI", kind: "json", key: "mcpServers", shape: "standard", files: [join(home, ".gemini", "settings.json")], commands: ["gemini"] },
    // The documentation names two places for Antigravity, so both are checked.
    { id: "antigravity", label: "Antigravity", kind: "json", key: "mcpServers", shape: "standard", files: [join(home, ".gemini", "antigravity", "mcp_config.json"), join(home, ".gemini", "config", "mcp_config.json")], dirs: [join(home, ".gemini", "antigravity")] },
    { id: "qwen-code", label: "Qwen Code", kind: "json", key: "mcpServers", shape: "standard", files: [join(home, ".qwen", "settings.json")], commands: ["qwen"] },
    { id: "kiro", label: "Kiro", kind: "json", key: "mcpServers", shape: "standard", files: [join(home, ".kiro", "settings", "mcp.json")], dirs: [join(home, ".kiro")] },
    { id: "opencode", label: "OpenCode", kind: "json", key: "mcp", shape: "opencode", files: [join(xdgConfig, "opencode", "opencode.json")], commentedFiles: [join(xdgConfig, "opencode", "opencode.jsonc")], commands: ["opencode"] },
    { id: "codex", label: "Codex CLI", kind: "toml", files: [join(codexHome, "config.toml")], dirs: [codexHome], commands: ["codex"] },
  ];
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function buildEntry(shape, options) {
  const args = [options.serverFile];
  const env = options.port ? { SUPERBASE_PORT: String(options.port) } : undefined;

  if (shape === "opencode") {
    return { type: "local", command: [options.node, ...args], ...(env ? { environment: env } : {}), enabled: true };
  }
  return {
    ...(shape === "vscode" ? { type: "stdio" } : {}),
    command: options.node,
    args,
    ...(env ? { env } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reading and writing files
// ---------------------------------------------------------------------------

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { data: {}, existed: false };
    return { error: error.message };
  }
  text = text.replace(/^﻿/, "");
  if (text.trim() === "") return { data: {}, existed: true };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "the file does not hold a JSON object" };
    return { data, existed: true };
  } catch {
    return { error: "the file is not plain JSON (comments or a trailing comma?), so it was left alone" };
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const target = `${file}.superbase-backup-${stamp()}`;
  fs.copyFileSync(file, target);
  return target;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// ---------------------------------------------------------------------------
// Codex keeps its servers in TOML tables, so the file is edited as text, one table at a time.
// ---------------------------------------------------------------------------

function tomlString(value) {
  return JSON.stringify(value);
}

function splitToml(text) {
  const sections = [{ header: null, lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) sections.push({ header: line.trim(), lines: [line] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

const OWN_TABLE = /^\[mcp_servers\.("?)superbase\1(\.|\])/;

function tomlWithout(text) {
  return splitToml(text)
    .filter((section) => !(section.header && OWN_TABLE.test(section.header)))
    .map((section) => section.lines.join("\n"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
}

function tomlBlock(entry) {
  const lines = [`[mcp_servers.${NAME}]`, `command = ${tomlString(entry.command)}`, `args = [${entry.args.map(tomlString).join(", ")}]`];
  if (entry.env) {
    lines.push("", `[mcp_servers.${NAME}.env]`);
    for (const [key, value] of Object.entries(entry.env)) lines.push(`${key} = ${tomlString(value)}`);
  }
  return lines.join("\n");
}

function tomlHasOwn(text) {
  return splitToml(text).some((section) => section.header && OWN_TABLE.test(section.header));
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function commandExists(name, ctx) {
  if (ctx.which) return Boolean(ctx.which(name));
  const result = spawnSync(ctx.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
  return result.status === 0;
}

// Returns { detected, file, reason } for one client.
function locate(client, ctx) {
  if (client.kind === "cli") {
    return { detected: client.commands.some((name) => commandExists(name, ctx)), file: null };
  }

  const existing = client.files.find((file) => fs.existsSync(file));
  if (existing) return { detected: true, file: existing };

  const commented = (client.commentedFiles || []).find((file) => fs.existsSync(file));
  if (commented) return { detected: true, file: commented, commented: true };

  const dirs = client.dirs || [];
  const withDir = client.files.find((file) => dirs.some((dir) => fs.existsSync(dir) && file.startsWith(dir)));
  if (withDir) return { detected: true, file: withDir };
  if (dirs.some((dir) => fs.existsSync(dir))) return { detected: true, file: client.files[0] };

  if ((client.commands || []).some((name) => commandExists(name, ctx))) return { detected: true, file: client.files[0] };
  return { detected: false, file: client.files ? client.files[0] : null };
}

// ---------------------------------------------------------------------------
// Doing the work
// ---------------------------------------------------------------------------

function sameEntry(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyJson(target, mode, options) {
  const { file, key, shape } = target;
  const read = readJson(file);
  if (read.error) return { status: "skipped", file, detail: read.error };

  const data = read.data;
  const servers = data[key];
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) {
    return { status: "skipped", file, detail: `"${key}" in the file is not an object, so it was left alone` };
  }
  const current = servers ? servers[NAME] : undefined;

  if (mode === "uninstall") {
    if (current === undefined) return { status: "absent", file };
    if (options.dryRun) return { status: "would-remove", file };
    const saved = backup(file);
    delete servers[NAME];
    writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
    return { status: "removed", file, backup: saved };
  }

  const entry = buildEntry(shape, options);
  if (current !== undefined && sameEntry(current, entry)) return { status: "unchanged", file };
  if (options.dryRun) return { status: current === undefined ? "would-add" : "would-update", file };

  const saved = backup(file);
  data[key] = { ...(servers || {}), [NAME]: entry };
  writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
  return { status: current === undefined ? "added" : "updated", file, backup: saved };
}

function applyToml(target, mode, options) {
  const { file } = target;
  let text = "";
  const existed = fs.existsSync(file);
  if (existed) {
    try {
      text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    } catch (error) {
      return { status: "skipped", file, detail: error.message };
    }
  }
  const has = tomlHasOwn(text);

  if (mode === "uninstall") {
    if (!has) return { status: "absent", file };
    if (options.dryRun) return { status: "would-remove", file };
    const saved = backup(file);
    const rest = tomlWithout(text);
    writeFile(file, rest ? `${rest}\n` : "");
    return { status: "removed", file, backup: saved };
  }

  const entry = buildEntry("standard", options);
  const block = tomlBlock(entry);
  const rest = tomlWithout(text);
  const next = `${rest ? `${rest}\n\n` : ""}${block}\n`;
  if (has && next.replace(/\r\n/g, "\n") === text.replace(/\r\n/g, "\n")) return { status: "unchanged", file };
  if (options.dryRun) return { status: has ? "would-update" : "would-add", file };
  const saved = existed ? backup(file) : null;
  writeFile(file, next);
  return { status: has ? "updated" : "added", file, backup: saved };
}

function quoteForShell(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function runCli(ctx, command, args, extra = {}) {
  if (ctx.exec) return ctx.exec(command, args, extra);
  const win = ctx.platform === "win32";
  const result = win
    ? spawnSync([command, ...args.map(quoteForShell)].join(" "), { shell: true, encoding: "utf8", ...extra })
    : spawnSync(command, args, { encoding: "utf8", ...extra });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

function applyClaudeCode(mode, options, ctx) {
  if (mode === "uninstall") {
    const args = ["mcp", "remove", NAME, "--scope", "user"];
    if (options.dryRun) return { status: "would-remove", detail: `claude ${args.join(" ")}` };
    const result = runCli(ctx, "claude", args);
    return result.status === 0 ? { status: "removed" } : { status: "absent", detail: (result.stderr || result.stdout || "").trim().split("\n")[0] };
  }

  // The name comes before -e, which takes several values, and -- ends the options.
  const add = ["mcp", "add", NAME, "--scope", "user"];
  if (options.port) add.push("-e", `SUPERBASE_PORT=${options.port}`);
  add.push("--", options.node, options.serverFile);
  if (options.dryRun) return { status: "would-add", detail: `claude ${add.join(" ")}` };

  // An older entry is replaced, so running the installer again never fails with "already exists".
  runCli(ctx, "claude", ["mcp", "remove", NAME, "--scope", "user"]);
  const result = runCli(ctx, "claude", add);
  if (result.status !== 0) return { status: "failed", detail: (result.stderr || result.stdout || "claude mcp add failed").trim().split("\n")[0] };
  return { status: "added" };
}

function applyClient(client, location, mode, options, ctx) {
  if (client.kind === "cli") return applyClaudeCode(mode, options, ctx);
  if (location.commented) {
    return { status: "skipped", file: location.file, detail: "it is a .jsonc file with comments, so it was left alone. Add the entry by hand, see --print" };
  }
  const target = { file: location.file, key: client.key, shape: client.shape };
  try {
    return client.kind === "toml" ? applyToml(target, mode, options) : applyJson(target, mode, options);
  } catch (error) {
    return { status: "failed", file: location.file, detail: error.message };
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const HELP = `Superbase installer

Registers the Superbase MCP server in the AI clients found on this computer.

  node scripts/install.js              pick the clients (arrow keys and space), install the dependency, register
  node scripts/install.js --yes        register in every client that was found
  node scripts/install.js --list       only show what was found
  node scripts/install.js --dry-run    show what would change and write nothing
  node scripts/install.js --uninstall  remove Superbase from the clients again

Options
  --client a,b      only these clients (ids are shown by --list), even if they were not detected
  --file <path>     register in any other JSON config file. Use --key (default mcpServers)
                    and --shape (standard, vscode or opencode, default standard)
  --port <n>        port of the bridge, when it is not 9731
  --node <command>  the command that starts Node.js (default: node)
  --no-deps         do not run "npm install" when the dependency is missing
  --plain           no colors and no interactive picker, just plain lines
  --print           print the config to add by hand and exit
  --help            this text

Every file is copied to <name>.superbase-backup-<time> before it changes.`;

function parseArgs(argv) {
  const options = { yes: false, dryRun: false, uninstall: false, list: false, print: false, help: false, clients: null, file: null, key: "mcpServers", shape: "standard", port: null, node: "node", noDeps: false, plain: false };
  const errors = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) errors.push(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--print") options.print = true;
    else if (arg === "--no-deps") options.noDeps = true;
    else if (arg === "--plain") options.plain = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--client") options.clients = String(value() || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--file") options.file = value();
    else if (arg === "--key") options.key = value();
    else if (arg === "--shape") options.shape = value();
    else if (arg === "--node") options.node = value();
    else if (arg === "--port") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("--port must be a number from 1 to 65535");
      else options.port = port;
    } else errors.push(`unknown option ${arg}`);
  }
  if (!["standard", "vscode", "opencode"].includes(options.shape)) errors.push("--shape must be standard, vscode or opencode");
  return { options, errors };
}

const STATUS_TEXT = {
  added: "added",
  updated: "updated",
  unchanged: "already up to date",
  removed: "removed",
  absent: "was not registered",
  "would-add": "would be added",
  "would-update": "would be updated",
  "would-remove": "would be removed",
  skipped: "skipped",
  failed: "FAILED",
};

function printConfig(options, out) {
  const snippet = (shape, key) => JSON.stringify({ [key]: { [NAME]: buildEntry(shape, options) } }, null, 2);
  out("Standard clients (Claude Desktop, Cursor, Windsurf, Cline, Roo Code, Gemini CLI, Antigravity, Qwen Code, Kiro):");
  out(snippet("standard", "mcpServers"));
  out("\nVS Code (mcp.json):");
  out(snippet("vscode", "servers"));
  out("\nOpenCode (opencode.json):");
  out(snippet("opencode", "mcp"));
  out("\nCodex CLI (config.toml):");
  out(tomlBlock(buildEntry("standard", options)));
  out("\nClaude Code:");
  out(`claude mcp add --scope user ${NAME} -- ${options.node} ${options.serverFile}`);
}

function ask(question, ctx) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: ctx.input || process.stdin, output: ctx.output || process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    rl.on("close", () => resolve(""));
  });
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

function dependenciesReady(root) {
  return fs.existsSync(path.join(root, "node_modules", "ws", "package.json"));
}

// Installs the one dependency when it is missing. Returns { status, detail } with status ready, installed,
// would-install, skipped or failed. `announce` is called right before the slow part starts.
function ensureDependencies(options, ctx, announce) {
  if (ctx.ensureDeps) return ctx.ensureDeps();
  if (options.noDeps) return { status: "skipped", detail: "--no-deps" };
  const root = path.dirname(path.dirname(options.serverFile));
  if (dependenciesReady(root)) return { status: "ready" };
  if (options.dryRun) return { status: "would-install" };
  if (announce) announce();
  const result = runCli(ctx, "npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: root, timeout: 300000 });
  if (result.error && result.error.code === "ENOENT") return { status: "failed", detail: "npm was not found. Install Node.js again with npm included" };
  if (result.status !== 0 || !dependenciesReady(root)) {
    const text = String(result.stderr || result.stdout || (result.error && result.error.message) || "").trim().split("\n").filter(Boolean).slice(-2).join(" ");
    return { status: "failed", detail: `npm install failed${text ? `: ${text}` : ""}. Run it yourself in ${root}` };
  }
  return { status: "installed" };
}

// ---------------------------------------------------------------------------
// Terminal look
// ---------------------------------------------------------------------------

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  } catch {
    return "";
  }
}

// A checklist in the terminal. Arrow keys (or j and k) move, space ticks, a ticks everything, enter confirms,
// q or escape cancels. items: { label, detail, checked, dimmed } or { heading }. Resolves with the indexes that
// are ticked, or null when it was cancelled.
function selectMany(items, { input, output, ui, title, hint }) {
  return new Promise((resolve) => {
    const choices = items.map((item, index) => (item.heading ? -1 : index)).filter((index) => index >= 0);
    let position = 0;
    let drawn = 0;
    const labelWidth = Math.max(...choices.map((index) => items[index].label.length));

    const render = () => {
      const columns = Math.max(48, (output.columns || 80) - 2);
      const lines = [`  ${ui.bold(title)}`, ""];
      items.forEach((item, index) => {
        if (item.heading) {
          lines.push(`  ${ui.dim(item.heading)}`);
          return;
        }
        const active = choices[position] === index;
        const pointer = active ? ui.cyan(ui.sym.cursor) : " ";
        const box = item.checked ? ui.green(ui.sym.on) : ui.dim(ui.sym.off);
        const label = item.label.padEnd(labelWidth);
        const text = active ? ui.bold(label) : item.dimmed && !item.checked ? ui.dim(label) : label;
        const room = columns - labelWidth - 10;
        const detail = item.detail && room > 8 ? shorten(item.detail, room, ui) : "";
        lines.push(`  ${pointer} ${box} ${text}  ${ui.dim(detail)}`.trimEnd());
      });
      lines.push("", `  ${ui.dim(hint)}`);
      output.write(`${drawn ? `\x1b[${drawn}A\x1b[J` : ""}${lines.join("\n")}\n`);
      drawn = lines.length;
    };

    const finish = (value) => {
      input.removeListener("data", onData);
      if (typeof input.setRawMode === "function") input.setRawMode(false);
      if (typeof input.pause === "function") input.pause();
      output.write(`${drawn ? `\x1b[${drawn}A\x1b[J` : ""}\x1b[?25h`);
      resolve(value);
    };

    const onData = (chunk) => {
      const keys = String(chunk).match(/\x1b\[[0-9;]*[A-Za-z]|\x1b|[\s\S]/g) || [];
      for (const key of keys) {
        if (key === "\x1b[A" || key === "k") position = (position - 1 + choices.length) % choices.length;
        else if (key === "\x1b[B" || key === "j") position = (position + 1) % choices.length;
        else if (key === " ") items[choices[position]].checked = !items[choices[position]].checked;
        else if (key === "a") {
          const all = choices.every((index) => items[index].checked);
          choices.forEach((index) => { items[index].checked = !all; });
        } else if (key === "\r" || key === "\n") return finish(choices.filter((index) => items[index].checked));
        else if (key === "q" || key === "\x03" || key === "\x1b") return finish(null);
      }
      render();
    };

    if (typeof input.setRawMode === "function") input.setRawMode(true);
    if (typeof input.setEncoding === "function") input.setEncoding("utf8");
    input.on("data", onData);
    if (typeof input.resume === "function") input.resume();
    output.write("\x1b[?25l");
    render();
  });
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

function tidy(file, home) {
  if (!file) return "";
  return home && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

// Returns { code, results }. `ctx` can replace the platform, the home folder, the environment and the
// way commands are found and run, which is how the tests use it.
async function run(argv, ctx = {}) {
  const context = {
    platform: ctx.platform || process.platform,
    home: ctx.home || os.homedir(),
    env: ctx.env || process.env,
    which: ctx.which,
    exec: ctx.exec,
    ensureDeps: ctx.ensureDeps,
    interactive: ctx.interactive !== undefined ? ctx.interactive : Boolean(process.stdin.isTTY),
    input: ctx.input,
    output: ctx.output,
  };
  const out = ctx.out || ((line) => console.log(line));

  const { options: parsed, errors } = parseArgs(argv);
  if (errors.length) {
    errors.forEach((message) => out(`Error: ${message}`));
    out("Run with --help to see the options.");
    return { code: 2, results: [] };
  }
  if (parsed.help) {
    out(HELP);
    return { code: 0, results: [] };
  }

  const fancy = !parsed.plain && (ctx.fancy !== undefined ? ctx.fancy : Boolean(process.stdout.isTTY) && !ctx.out);
  const ui = makeUi(fancy && !context.env.NO_COLOR, fancy && supportsUnicode(context.platform, context.env));

  const options = { ...parsed, serverFile: ctx.serverFile || SERVER_FILE };
  if (options.print) {
    printConfig(options, out);
    return { code: 0, results: [] };
  }

  // npx unpacks a package into a cache that npm cleans up later, and the clients would be left pointing at nothing.
  if (!options.dryRun && /[\\/]_npx[\\/]/.test(options.serverFile)) {
    out("This copy of Superbase sits in the temporary npx cache, which npm deletes later, so the clients would lose it.");
    out("Install it first, then run the setup again:");
    out("  npm install -g github:fiangg20/superbase");
    out("  superbase-setup");
    return { code: 2, results: [] };
  }

  if (!fs.existsSync(options.serverFile)) {
    out(`Error: ${options.serverFile} was not found. Run this from a complete copy of Superbase.`);
    return { code: 1, results: [] };
  }

  const mode = options.uninstall ? "uninstall" : "install";
  const clients = buildClients(context);

  // A file that is given by hand is its own client.
  if (options.file) {
    const custom = { id: "file", label: options.file, kind: "json", key: options.key, shape: options.shape, files: [path.resolve(options.file)] };
    const result = applyClient(custom, { detected: true, file: custom.files[0] }, mode, options, context);
    out(`${custom.label}: ${STATUS_TEXT[result.status] || result.status}${result.detail ? ` (${result.detail})` : ""}`);
    if (result.backup) out(`  backup: ${result.backup}`);
    return { code: result.status === "failed" ? 1 : 0, results: [{ client: custom, result }] };
  }

  const known = new Set(clients.map((client) => client.id));
  if (options.clients) {
    const unknown = options.clients.filter((id) => !known.has(id));
    if (unknown.length) {
      out(`Error: unknown client ${unknown.join(", ")}. Known: ${[...known].join(", ")}`);
      return { code: 2, results: [] };
    }
  }

  const found = clients.map((client) => ({ client, location: locate(client, context) }));
  const chosenByName = options.clients ? found.filter((item) => options.clients.includes(item.client.id)) : null;
  const detected = found.filter((item) => item.location.detected);
  const where = (item) => (item.client.kind === "cli" ? "the claude command" : tidy(item.location.file, context.home));
  const dryNote = options.dryRun ? " (dry run, nothing is written)" : "";

  if (fancy) {
    const version = packageVersion();
    banner(ui, `Superbase${version ? ` ${version}` : ""}${options.dryRun ? "  dry run" : ""}`, mode === "uninstall" ? "Remove it from your AI clients" : "Connect your AI clients to Roblox", out);
  } else {
    out(`Superbase installer${dryNote}`);
    out("");
  }

  if (!fancy || options.list) {
    found.forEach((item, index) => {
      if (fancy) {
        const on = item.location.detected;
        out(`  ${on ? ui.green(ui.sym.ok) : ui.dim(ui.sym.off)} ${on ? item.client.label.padEnd(18) : ui.dim(item.client.label.padEnd(18))}${ui.dim(on ? where(item) : "not found")}`);
      } else {
        const mark = item.location.detected ? "found    " : "not found";
        out(`  ${String(index + 1).padStart(2)}. [${mark}] ${item.client.label}  (${item.client.id})`);
      }
    });
    out("");
  }

  if (options.list) return { code: 0, results: [] };

  let selected;
  if (chosenByName) {
    selected = chosenByName;
  } else {
    if (detected.length === 0) {
      out("No supported AI client was found. Install one first, or add the config by hand:");
      out("  node scripts/install.js --print     shows the config for every client");
      out("  node scripts/install.js --file <path-to-a-json-config>");
      return { code: 0, results: [] };
    }
    const stream = context.input || process.stdin;
    if (options.yes || options.dryRun) {
      selected = detected;
    } else if (!context.interactive) {
      out("Nothing was changed, because this is not an interactive terminal. Run it again with --yes to use");
      out(`every client that was found (${detected.map((item) => item.client.id).join(", ")}), or pick some with --client.`);
      return { code: 0, results: [] };
    } else if (fancy && typeof stream.setRawMode === "function") {
      const ordered = [...detected, ...found.filter((item) => !item.location.detected)];
      const items = [{ heading: `Found on this computer (${detected.length})` }];
      detected.forEach((item) => items.push({ label: item.client.label, detail: where(item), checked: true }));
      const missing = ordered.length - detected.length;
      if (missing > 0) {
        items.push({ heading: mode === "uninstall" ? `Not found (${missing})` : `Not found (${missing}), tick one to create its config anyway` });
        ordered.slice(detected.length).forEach((item) => items.push({ label: item.client.label, detail: tidy(item.location.file, context.home), checked: false, dimmed: true }));
      }
      const indexes = await selectMany(items, {
        input: stream,
        output: context.output || process.stdout,
        ui,
        title: mode === "uninstall" ? "Remove Superbase from" : "Register Superbase in",
        hint: "up/down move   space tick   a all   enter confirm   q cancel".replace(/up\/down/, ui.unicode ? "↑↓" : "up/down"),
      });
      if (!indexes || indexes.length === 0) {
        out(`  ${ui.dim("Nothing was changed.")}`);
        return { code: 0, results: [] };
      }
      // Map the ticked rows back to the clients in the same order they were listed.
      const rows = items.map((item, index) => ({ item, index })).filter((row) => !row.item.heading);
      selected = indexes.map((index) => ordered[rows.findIndex((row) => row.index === index)]);
      out(`  ${ui.green(ui.sym.ok)} ${selected.map((item) => item.client.label).join(", ")}`);
      out("");
    } else {
      const label = mode === "uninstall" ? "Remove Superbase from" : "Register Superbase in";
      const answer = await ask(`${label} all ${detected.length} found client(s)? [Y]es / [n]o / numbers like 1,3: `, context);
      if (/^(n|no)$/i.test(answer)) {
        out("Nothing was changed.");
        return { code: 0, results: [] };
      }
      if (answer === "" || /^(y|yes)$/i.test(answer)) {
        selected = detected;
      } else {
        const picks = new Set(answer.split(/[ ,]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= found.length));
        selected = found.filter((_, index) => picks.has(index + 1));
        if (selected.length === 0) {
          out("No valid number. Nothing was changed.");
          return { code: 0, results: [] };
        }
      }
    }
  }

  // The dependency is installed before the clients are told about the server, so it starts on the first try.
  let deps = null;
  if (mode === "install" && selected.length > 0) {
    deps = ensureDependencies(options, context, () => out(`  ${ui.dim(fancy ? "Installing the dependency (npm install), this takes a moment..." : "Installing the dependency (npm install)...")}`));
  }

  const rows = [];
  if (deps && deps.status !== "skipped") {
    const text = { ready: "already installed", installed: "installed", "would-install": "would be installed", failed: "FAILED" }[deps.status];
    rows.push({ label: "Dependencies", status: deps.status === "failed" ? "failed" : deps.status === "ready" ? "unchanged" : deps.status === "installed" ? "added" : "would-add", text, detail: deps.detail });
  }

  const results = [];
  for (const item of selected) {
    const result = applyClient(item.client, item.location, mode, options, context);
    results.push({ client: item.client, result });
    rows.push({ label: item.client.label, status: result.status, text: STATUS_TEXT[result.status] || result.status, detail: result.detail, file: result.file, backup: result.backup });
  }

  const width = Math.max(...rows.map((row) => row.label.length));
  for (const row of rows) {
    const quiet = ["unchanged", "absent"].includes(row.status);
    if (fancy) {
      const good = ["added", "updated", "removed", "would-add", "would-update", "would-remove"].includes(row.status);
      const symbol = row.status === "failed" ? ui.red(ui.sym.fail) : row.status === "skipped" ? ui.yellow(ui.sym.warn) : good ? ui.green(ui.sym.ok) : ui.dim(ui.sym.dot);
      const text = row.status === "failed" ? ui.red(row.text) : row.status === "skipped" ? ui.yellow(row.text) : quiet ? ui.dim(row.text) : row.text;
      out(`  ${symbol} ${row.label.padEnd(width)}  ${text}`);
      if (row.detail) out(`      ${ui.dim(row.detail)}`);
      if (row.file && !quiet) out(`      ${ui.dim(tidy(row.file, context.home))}`);
      if (row.backup) out(`      ${ui.dim(`backup ${tidy(row.backup, context.home)}`)}`);
    } else {
      out(`  ${row.label}: ${row.text}${row.detail ? ` (${row.detail})` : ""}`);
      if (row.file && !quiet) out(`    file: ${row.file}`);
      if (row.backup) out(`    backup: ${row.backup}`);
    }
  }

  const failed = rows.filter((row) => row.status === "failed").length;
  const changed = results.filter((item) => ["added", "updated", "removed"].includes(item.result.status)).length;
  const registered = mode === "install" && !options.dryRun && results.some((item) => ["added", "updated", "unchanged"].includes(item.result.status));
  out("");
  if (fancy && registered) {
    out(`  ${ui.bold("Next")}`);
    out(`    ${ui.cyan("1")}  Restart the AI client so it loads the change`);
    out(`    ${ui.cyan("2")}  Start the bridge:  ${ui.cyan("npm start")}`);
    out(`    ${ui.cyan("3")}  Ask the AI: ${ui.dim('"Check the Roblox connection."')}`);
    out("");
  } else if (!fancy) {
    if (changed > 0) out("Restart the AI client so it loads the change.");
    if (registered) out("Then start the bridge (npm start) and ask the AI to check the Roblox connection.");
  } else if (changed > 0) {
    out(`  ${ui.dim("Restart the AI client so it loads the change.")}`);
    out("");
  }
  return { code: failed ? 1 : 0, results, dependencies: deps };
}

module.exports = { selectMany, makeUi, buildClients, buildEntry, locate, run, parseArgs, tomlBlock, tomlWithout, tomlHasOwn, readJson, SERVER_FILE };

if (require.main === module) {
  run(process.argv.slice(2)).then(
    ({ code }) => process.exit(code),
    (error) => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    },
  );
}
