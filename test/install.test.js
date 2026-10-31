"use strict";

// Tests for scripts/install.js. Every test uses a fake home folder, so no real config file is touched.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const { run, buildClients, selectMany, makeUi, SERVER_FILE } = require("../scripts/install");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-install-"));
let counter = 0;

function fakeHome() {
  counter += 1;
  const home = path.join(tmpRoot, `home${counter}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function context(home, extra = {}) {
  const lines = [];
  return { ctx: { platform: "linux", home, env: { XDG_CONFIG_HOME: path.join(home, ".config") }, which: () => null, ensureDeps: () => ({ status: "ready" }), interactive: false, out: (line) => lines.push(line), ...extra }, lines };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const backups = (file) => fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.superbase-backup-`));
const status = (result, id) => result.results.find((item) => item.client.id === id).result.status;

async function main() {
  const entryPath = SERVER_FILE;

  // Detection: only clients that are really there are found.
  {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".cursor"));
    fs.mkdirSync(path.join(home, ".kiro"));
    const { ctx, lines } = context(home);
    const result = await run(["--list"], ctx);
    assert.strictEqual(result.code, 0);
    const text = lines.join("\n");
    assert.ok(/\[found\s*\] Cursor/.test(text) && /\[found\s*\] Kiro/.test(text), text);
    assert.ok(/\[not found\] Windsurf/.test(text) && /\[not found\] Codex CLI/.test(text), text);
    assert.ok(!fs.existsSync(path.join(home, ".cursor", "mcp.json")), "listing writes nothing");
  }

  // A non interactive run without --yes writes nothing.
  {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".cursor"));
    const { ctx, lines } = context(home);
    await run([], ctx);
    assert.ok(!fs.existsSync(path.join(home, ".cursor", "mcp.json")));
    assert.ok(lines.join("\n").includes("--yes"));
  }

  // Install into a new file and into an existing file that has other servers and other settings.
  {
    const home = fakeHome();
    const cursorFile = path.join(home, ".cursor", "mcp.json");
    const kiroFile = path.join(home, ".kiro", "settings", "mcp.json");
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
    fs.mkdirSync(path.dirname(kiroFile), { recursive: true });
    fs.writeFileSync(kiroFile, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x", args: ["1"] } } }));

    const { ctx } = context(home);
    const result = await run(["--yes"], ctx);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(status(result, "cursor"), "added");
    assert.strictEqual(status(result, "kiro"), "added");

    assert.deepStrictEqual(readJson(cursorFile), { mcpServers: { superbase: { command: "node", args: [entryPath] } } });
    const kiro = readJson(kiroFile);
    assert.strictEqual(kiro.theme, "dark", "other settings are kept");
    assert.deepStrictEqual(kiro.mcpServers.other, { command: "x", args: ["1"] }, "other servers are kept");
    assert.deepStrictEqual(kiro.mcpServers.superbase, { command: "node", args: [entryPath] });
    assert.strictEqual(backups(kiroFile).length, 1, "an existing file is backed up");
    assert.strictEqual(backups(cursorFile).length, 0, "a new file has nothing to back up");

    // Again: nothing changes and no extra backup appears.
    const again = await run(["--yes"], context(home).ctx);
    assert.strictEqual(status(again, "cursor"), "unchanged");
    assert.strictEqual(status(again, "kiro"), "unchanged");
    assert.strictEqual(backups(kiroFile).length, 1);

    // A different port updates the entry in place.
    const withPort = await run(["--yes", "--port", "9800"], context(home).ctx);
    assert.strictEqual(status(withPort, "cursor"), "updated");
    assert.deepStrictEqual(readJson(cursorFile).mcpServers.superbase.env, { SUPERBASE_PORT: "9800" });

    // Dry run changes nothing.
    const before = fs.readFileSync(cursorFile, "utf8");
    const dry = await run(["--dry-run", "--port", "9900"], context(home).ctx);
    assert.strictEqual(status(dry, "cursor"), "would-update");
    assert.strictEqual(fs.readFileSync(cursorFile, "utf8"), before);

    // Uninstall removes only our entry.
    const removed = await run(["--uninstall", "--yes"], context(home).ctx);
    assert.strictEqual(status(removed, "kiro"), "removed");
    assert.deepStrictEqual(readJson(kiroFile).mcpServers, { other: { command: "x", args: ["1"] } });
    assert.strictEqual(readJson(kiroFile).theme, "dark");
    assert.deepStrictEqual(readJson(cursorFile).mcpServers, {});
    const gone = await run(["--uninstall", "--yes"], context(home).ctx);
    assert.strictEqual(status(gone, "kiro"), "absent");
  }

  // Files that are not plain JSON are never rewritten.
  {
    const home = fakeHome();
    const file = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const commented = '{\n  // my servers\n  "mcpServers": {}\n}\n';
    fs.writeFileSync(file, commented);
    const result = await run(["--yes"], context(home).ctx);
    assert.strictEqual(status(result, "cursor"), "skipped");
    assert.strictEqual(fs.readFileSync(file, "utf8"), commented, "the file is untouched");
    assert.strictEqual(backups(file).length, 0);
    assert.strictEqual(result.code, 0, "a skipped file is not a failure");

    fs.writeFileSync(file, '{ "mcpServers": [] }');
    assert.strictEqual(status(await run(["--yes"], context(home).ctx), "cursor"), "skipped", "a wrong shape is left alone");
  }

  // VS Code uses "servers" with a type, OpenCode uses a command array.
  {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".config", "Code", "User"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", theme: "x" }));
    const result = await run(["--yes", "--client", "vscode,opencode"], context(home).ctx);
    assert.strictEqual(status(result, "vscode"), "added");
    assert.strictEqual(status(result, "opencode"), "added");
    assert.deepStrictEqual(readJson(path.join(home, ".config", "Code", "User", "mcp.json")), { servers: { superbase: { type: "stdio", command: "node", args: [entryPath] } } });
    const opencode = readJson(path.join(home, ".config", "opencode", "opencode.json"));
    assert.strictEqual(opencode.theme, "x");
    assert.deepStrictEqual(opencode.mcp.superbase, { type: "local", command: ["node", entryPath], enabled: true });

    // A .jsonc file with comments is not edited.
    const other = fakeHome();
    fs.mkdirSync(path.join(other, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(other, ".config", "opencode", "opencode.jsonc"), "{ // hi\n}");
    const skipped = await run(["--yes"], context(other).ctx);
    assert.strictEqual(status(skipped, "opencode"), "skipped");
    assert.ok(!fs.existsSync(path.join(other, ".config", "opencode", "opencode.json")));
  }

  // Cline and Roo Code live in the VS Code extension storage.
  {
    const home = fakeHome();
    const store = path.join(home, ".config", "Code", "User", "globalStorage");
    fs.mkdirSync(path.join(store, "saoudrizwan.claude-dev"), { recursive: true });
    fs.mkdirSync(path.join(store, "rooveterinaryinc.roo-cline"), { recursive: true });
    const result = await run(["--yes", "--client", "cline,roo-code"], context(home).ctx);
    assert.strictEqual(status(result, "cline"), "added");
    assert.strictEqual(status(result, "roo-code"), "added");
    assert.ok(readJson(path.join(store, "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")).mcpServers.superbase);
    assert.ok(readJson(path.join(store, "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json")).mcpServers.superbase);
  }

  // Antigravity: the folder that exists decides where the file goes.
  {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
    fs.writeFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "{}");
    const result = await run(["--yes", "--client", "antigravity"], context(home).ctx);
    assert.strictEqual(status(result, "antigravity"), "added");
    assert.ok(readJson(path.join(home, ".gemini", "config", "mcp_config.json")).mcpServers.superbase, "the existing file is used");
    assert.ok(!fs.existsSync(path.join(home, ".gemini", "antigravity")), "no second location is created");
  }

  // Codex: TOML tables, other tables kept, our table replaced and removed cleanly.
  {
    const home = fakeHome();
    const file = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\nargs = ["1"]\n\n[profiles.fast]\nmodel = "mini"\n');
    const first = await run(["--yes", "--client", "codex"], context(home).ctx);
    assert.strictEqual(status(first, "codex"), "added");
    let text = fs.readFileSync(file, "utf8");
    assert.ok(text.includes('model = "gpt-5"') && text.includes("[mcp_servers.other]") && text.includes("[profiles.fast]"), text);
    assert.ok(text.includes("[mcp_servers.superbase]") && text.includes('command = "node"'), text);
    assert.ok(text.includes(`args = [${JSON.stringify(entryPath)}]`), text);
    assert.strictEqual(backups(file).length, 1);

    assert.strictEqual(status(await run(["--yes", "--client", "codex"], context(home).ctx), "codex"), "unchanged");
    assert.strictEqual(status(await run(["--yes", "--client", "codex", "--port", "9800"], context(home).ctx), "codex"), "updated");
    text = fs.readFileSync(file, "utf8");
    assert.strictEqual((text.match(/\[mcp_servers\.superbase\]/g) || []).length, 1, "the table is replaced, not repeated");
    assert.ok(text.includes("[mcp_servers.superbase.env]") && text.includes('SUPERBASE_PORT = "9800"'), text);

    assert.strictEqual(status(await run(["--uninstall", "--yes", "--client", "codex"], context(home).ctx), "codex"), "removed");
    text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes("superbase") && text.includes("[mcp_servers.other]") && text.includes("[profiles.fast]"), text);
  }

  // Claude Code goes through its own command, and an older entry is replaced first.
  {
    const home = fakeHome();
    const calls = [];
    const { ctx } = context(home, { which: (name) => (name === "claude" ? "/usr/bin/claude" : null), exec: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: "", stderr: "" }; } });
    const result = await run(["--yes", "--client", "claude-code", "--port", "9800"], ctx);
    assert.strictEqual(status(result, "claude-code"), "added");
    assert.deepStrictEqual(calls[0], ["claude", "mcp", "remove", "superbase", "--scope", "user"]);
    assert.deepStrictEqual(calls[1], ["claude", "mcp", "add", "superbase", "--scope", "user", "-e", "SUPERBASE_PORT=9800", "--", "node", entryPath]);

    calls.length = 0;
    await run(["--dry-run", "--client", "claude-code"], context(home, { exec: (c, a) => { calls.push([c, ...a]); return { status: 0, stdout: "", stderr: "" }; } }).ctx);
    assert.strictEqual(calls.length, 0, "a dry run runs nothing");

    const failing = await run(["--yes", "--client", "claude-code"], context(home, { exec: () => ({ status: 1, stdout: "", stderr: "boom\nmore" }) }).ctx);
    assert.strictEqual(status(failing, "claude-code"), "failed");
    assert.strictEqual(failing.code, 1);
  }

  // Windows layout, including the Microsoft Store version of Claude Desktop.
  {
    const home = fakeHome();
    const appData = path.join(home, "AppData", "Roaming");
    const local = path.join(home, "AppData", "Local");
    const storeDir = path.join(local, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude");
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(path.join(appData, "Code", "User"), { recursive: true });
    const { ctx } = context(home, { platform: "win32", env: { APPDATA: appData, LOCALAPPDATA: local } });
    const result = await run(["--yes"], ctx);
    assert.strictEqual(status(result, "claude-desktop"), "added");
    assert.ok(readJson(path.join(storeDir, "claude_desktop_config.json")).mcpServers.superbase, "the Store package folder is used");
    assert.ok(readJson(path.join(appData, "Code", "User", "mcp.json")).servers.superbase);
    const win = buildClients({ platform: "win32", home, env: { APPDATA: appData, LOCALAPPDATA: local } });
    assert.ok(win.find((c) => c.id === "claude-desktop").files[0].endsWith(path.join("Claude", "claude_desktop_config.json")));
  }

  // Any other JSON file can be used with --file.
  {
    const home = fakeHome();
    const file = path.join(home, "custom.json");
    const result = await run(["--file", file, "--key", "servers", "--shape", "vscode"], context(home).ctx);
    assert.strictEqual(result.results[0].result.status, "added");
    assert.deepStrictEqual(readJson(file).servers.superbase.type, "stdio");
  }

  // A copy inside the npx cache is refused, because npm deletes that folder later.
  {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".cursor"));
    const { ctx, lines } = context(home, { serverFile: path.join(home, ".npm", "_npx", "abc", "node_modules", "superbase", "src", "mcp-server.js") });
    const result = await run(["--yes"], ctx);
    assert.strictEqual(result.code, 2);
    assert.ok(lines.join("\n").includes("npm install -g"));
    assert.ok(!fs.existsSync(path.join(home, ".cursor", "mcp.json")));
  }

  // The package exposes the three commands.
  {
    const pkg = require("../package.json");
    assert.deepStrictEqual(Object.keys(pkg.bin).sort(), ["superbase", "superbase-mcp", "superbase-setup"]);
    for (const file of Object.values(pkg.bin)) {
      const text = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      assert.ok(text.startsWith("#!/usr/bin/env node"), `${file} needs a shebang`);
    }
  }

  // Bad input.
  {
    const home = fakeHome();
    assert.strictEqual((await run(["--nope"], context(home).ctx)).code, 2);
    assert.strictEqual((await run(["--port", "abc"], context(home).ctx)).code, 2);
    assert.strictEqual((await run(["--client", "nothing"], context(home).ctx)).code, 2);
    assert.strictEqual((await run(["--shape", "x"], context(home).ctx)).code, 2);
    const { ctx, lines } = context(home);
    assert.strictEqual((await run(["--print"], ctx)).code, 0);
    assert.ok(lines.join("\n").includes("claude mcp add") && lines.join("\n").includes("[mcp_servers.superbase]"));
  }

  // The real command line, with a fake home folder.
  {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".cursor"));
    const script = path.join(__dirname, "..", "scripts", "install.js");
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: path.dirname(process.execPath) };
    const res = spawnSync(process.execPath, [script, "--yes", "--no-deps", "--client", "cursor"], { env, encoding: "utf8" });
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.ok(res.stdout.includes("Cursor: added"), res.stdout);
    assert.ok(readJson(path.join(home, ".cursor", "mcp.json")).mcpServers.superbase);
    const help = spawnSync(process.execPath, [script, "--help"], { env, encoding: "utf8" });
    assert.ok(help.stdout.includes("--uninstall"));
  }


  // The dependency is installed first, and only when it is missing.
  {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".cursor"));
    const root = path.join(home, "copy");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "mcp-server.js"), "");
    const calls = [];
    const exec = (command, args, extra) => {
      calls.push({ command, args, cwd: extra && extra.cwd });
      fs.mkdirSync(path.join(root, "node_modules", "ws"), { recursive: true });
      fs.writeFileSync(path.join(root, "node_modules", "ws", "package.json"), "{}");
      return { status: 0, stdout: "", stderr: "" };
    };
    const base = { ensureDeps: undefined, exec, serverFile: path.join(root, "src", "mcp-server.js") };

    const dry = await run(["--dry-run"], context(home, base).ctx);
    assert.strictEqual(dry.dependencies.status, "would-install");
    assert.strictEqual(calls.length, 0, "a dry run installs nothing");

    const first = await run(["--yes", "--client", "cursor"], context(home, base).ctx);
    assert.strictEqual(first.dependencies.status, "installed");
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].args.slice(0, 2), ["install", "--omit=dev"]);
    assert.strictEqual(calls[0].cwd, root);

    const second = await run(["--yes", "--client", "cursor"], context(home, base).ctx);
    assert.strictEqual(second.dependencies.status, "ready");
    assert.strictEqual(calls.length, 1, "nothing is installed twice");

    // --no-deps and uninstall never touch npm.
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    await run(["--yes", "--client", "cursor", "--no-deps"], context(home, base).ctx);
    await run(["--uninstall", "--yes", "--client", "cursor"], context(home, base).ctx);
    assert.strictEqual(calls.length, 1);

    // When npm fails the clients are still registered, and the exit code says something went wrong.
    const failing = await run(["--yes", "--client", "cursor"], context(home, { ...base, exec: () => ({ status: 1, stdout: "", stderr: "ENOTFOUND registry" }) }).ctx);
    assert.strictEqual(failing.dependencies.status, "failed");
    assert.strictEqual(failing.code, 1);
    assert.ok(readJson(path.join(home, ".cursor", "mcp.json")).mcpServers.superbase, "the client is registered anyway");
    const missing = await run(["--yes", "--client", "cursor"], context(home, { ...base, exec: () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } }) }).ctx);
    assert.ok(/npm was not found/.test(missing.dependencies.detail));
  }

  // The picker: keys, cancel, and the mapping back to clients.
  {
    const fakeInput = () => Object.assign(new EventEmitter(), { setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
    const ui = makeUi(false, false);
    const items = () => [{ heading: "Found" }, { label: "One", detail: "a", checked: true }, { label: "Two", detail: "b", checked: true }, { heading: "Missing" }, { label: "Three", detail: "c", checked: false }];

    let input = fakeInput();
    let screen = "";
    let promise = selectMany(items(), { input, output: { write: (text) => { screen += text; }, columns: 80 }, ui, title: "Pick", hint: "hint" });
    input.emit("data", "\x1b[B");
    input.emit("data", " ");
    input.emit("data", "\r");
    assert.deepStrictEqual(await promise, [1], "down, space unticks Two, enter confirms");
    assert.ok(screen.includes("[x] One") && screen.includes("[ ] Two") && screen.includes("> "), screen);
    assert.ok(screen.includes("\x1b[?25l") && screen.includes("\x1b[?25h"), "the cursor is hidden and shown again");
    assert.strictEqual(input.listenerCount("data"), 0, "the listener is removed");

    input = fakeInput();
    promise = selectMany(items(), { input, output: { write() {} }, ui, title: "Pick", hint: "" });
    input.emit("data", "a");
    input.emit("data", "\n");
    assert.deepStrictEqual(await promise, [1, 2, 4], "a ticks everything, including the clients that were not found");

    input = fakeInput();
    promise = selectMany(items(), { input, output: { write() {} }, ui, title: "Pick", hint: "" });
    input.emit("data", "a");
    input.emit("data", "a");
    input.emit("data", "j\x1b[A\x1b[A");
    input.emit("data", "\r");
    assert.deepStrictEqual(await promise, [], "a twice clears everything");

    input = fakeInput();
    promise = selectMany(items(), { input, output: { write() {} }, ui, title: "Pick", hint: "" });
    input.emit("data", "q");
    assert.strictEqual(await promise, null, "q cancels");
    input = fakeInput();
    promise = selectMany(items(), { input, output: { write() {} }, ui, title: "Pick", hint: "" });
    input.emit("data", "\x03");
    assert.strictEqual(await promise, null, "ctrl+c cancels");
  }

  // The whole interactive run with the picker: the unticked client is left alone.
  {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".cursor"));
    fs.mkdirSync(path.join(home, ".kiro"));
    const input = Object.assign(new EventEmitter(), { setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
    let screen = "";
    const { ctx, lines } = context(home, { interactive: true, fancy: true, input, output: { write: (text) => { screen += text; }, columns: 100 } });
    const pending = run([], ctx);
    input.emit("data", "\x1b[B");
    input.emit("data", " ");
    input.emit("data", "\r");
    const result = await pending;
    assert.strictEqual(result.code, 0);
    assert.ok(/Found on this computer \(2\)/.test(screen) && /Not found \(\d+\)/.test(screen), screen);
    assert.ok(readJson(path.join(home, ".cursor", "mcp.json")).mcpServers.superbase);
    assert.ok(!fs.existsSync(path.join(home, ".kiro", "settings", "mcp.json")), "the unticked client is not touched");
    const text = lines.join("\n");
    assert.ok(text.includes("Dependencies") && text.includes("Cursor") && text.includes("npm start"), text);

    // Cancel changes nothing.
    const home2 = fakeHome();
    fs.mkdirSync(path.join(home2, ".cursor"));
    const input2 = Object.assign(new EventEmitter(), { setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
    const pending2 = run([], context(home2, { interactive: true, fancy: true, input: input2, output: { write() {}, columns: 100 } }).ctx);
    input2.emit("data", "q");
    await pending2;
    assert.ok(!fs.existsSync(path.join(home2, ".cursor", "mcp.json")));
  }

  // package.json has the npm commands.
  {
    const pkg = readJson(path.join(__dirname, "..", "package.json"));
    assert.strictEqual(pkg.scripts.setup, "node scripts/install.js");
    assert.strictEqual(pkg.scripts.delete, "node scripts/install.js --uninstall");
    assert.ok(pkg.scripts.test.includes("test/install.test.js"));
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("ALL INSTALLER CHECKS PASSED");
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
