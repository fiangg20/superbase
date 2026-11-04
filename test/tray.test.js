"use strict";

// The tray icon: when it starts, how PowerShell is called, and static checks of tray.ps1 (it cannot run on Linux).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const tray = require("../src/tray");

const ps1 = fs.readFileSync(tray.SCRIPT_FILE, "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-tray-test-"));
const icon = path.join(tmp, "icon.png");
fs.writeFileSync(icon, "png");

function fakeSpawn() {
  const calls = [];
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ command, args, options, child });
    return child;
  };
  return { calls, spawnFn };
}

const settings = { port: 9731, host: "127.0.0.1", token: "", tray: true };
const options = { settings, version: "1.4.0", logFile: "C:\\Superbase\\.superbase\\bridge.log" };
const base = (extra = {}) => ({ platform: "win32", exists: () => true, unblock: () => {}, iconFile: icon, pid: 4242, execPath: "C:\\Program Files\\nodejs\\node.exe", cliFile: "C:\\Superbase\\scripts\\superbase.js", ...extra });

// Only Windows, only when it is turned on, only when the script is there.
let fake = fakeSpawn();
let result = tray.start(options, base({ platform: "linux", spawnFn: fake.spawnFn }));
assert.strictEqual(result.started, false);
assert.ok(/only available on Windows/.test(result.reason));
assert.strictEqual(fake.calls.length, 0, "nothing is started on Linux");
result = tray.start({ ...options, settings: { ...settings, tray: false } }, base({ spawnFn: fake.spawnFn }));
assert.ok(!result.started && /turned off/.test(result.reason) && fake.calls.length === 0);
result = tray.start(options, base({ spawnFn: fake.spawnFn, exists: () => false }));
assert.ok(!result.started && /is missing/.test(result.reason) && fake.calls.length === 0);
result = tray.start(options, base({ spawnFn: () => { throw new Error("EPERM"); } }));
assert.ok(!result.started && /Could not start PowerShell: EPERM/.test(result.reason));

// The command line.
fake = fakeSpawn();
const unblocked = [];
result = tray.start(options, base({ spawnFn: fake.spawnFn, unblock: (file) => unblocked.push(file) }));
assert.strictEqual(result.started, true);
assert.deepStrictEqual(unblocked, [tray.SCRIPT_FILE], "the script is unblocked first");
const call = fake.calls[0];
assert.strictEqual(call.command, "powershell.exe");
assert.deepStrictEqual(call.args.slice(0, 7), ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "RemoteSigned", "-File", tray.SCRIPT_FILE]);
const named = {};
for (let i = 7; i < call.args.length; i += 2) named[call.args[i]] = call.args[i + 1];
assert.deepStrictEqual(named, {
  "-Port": "9731", "-BridgeHost": "127.0.0.1", "-BridgePid": "4242", "-Version": "1.4.0",
  "-NodePath": "C:\\Program Files\\nodejs\\node.exe", "-CliPath": "C:\\Superbase\\scripts\\superbase.js", "-LogFile": options.logFile, "-IconFile": icon,
});
assert.strictEqual(call.options.windowsHide, true, "no window");
assert.ok(!/bypass|encodedcommand|hidden/i.test(call.args.join(" ")), "no flags that look like malware to a scanner");

// A missing icon file is not passed, a wildcard host becomes this computer, an IPv6 address is bracketed.
fake = fakeSpawn();
tray.start({ ...options, settings: { ...settings, host: "0.0.0.0" } }, base({ spawnFn: fake.spawnFn, exists: (file) => file !== icon }));
assert.ok(!fake.calls[0].args.includes("-IconFile"), "no icon file, no argument");
assert.strictEqual(fake.calls[0].args[fake.calls[0].args.indexOf("-BridgeHost") + 1], "127.0.0.1");
fake = fakeSpawn();
tray.start({ ...options, settings: { ...settings, host: "::" } }, base({ spawnFn: fake.spawnFn }));
assert.strictEqual(fake.calls[0].args[fake.calls[0].args.indexOf("-BridgeHost") + 1], "[::1]");

// The token travels in the environment, never in the arguments.
fake = fakeSpawn();
const secret = "0123456789abcdef-secret-token";
tray.start({ ...options, settings: { ...settings, token: secret } }, base({ spawnFn: fake.spawnFn, env: { PATH: "x", SUPERBASE_TRAY_TOKEN: "old" } }));
assert.strictEqual(fake.calls[0].options.env.SUPERBASE_TRAY_TOKEN, secret);
assert.ok(!fake.calls[0].args.join(" ").includes(secret), "the token is not on the command line");
fake = fakeSpawn();
tray.start(options, base({ spawnFn: fake.spawnFn, env: { PATH: "x", SUPERBASE_TRAY_TOKEN: "old" } }));
assert.ok(!("SUPERBASE_TRAY_TOKEN" in fake.calls[0].options.env), "no token, no variable (a stale one is removed)");

// What happens when PowerShell ends.
fake = fakeSpawn();
const lines = [];
result = tray.start(options, base({ spawnFn: fake.spawnFn, log: (line) => lines.push(line) }));
fake.calls[0].child.stderr.emit("data", Buffer.from("File is not digitally signed.\n  At line:1"));
fake.calls[0].child.emit("exit", 1);
assert.strictEqual(lines.length, 1);
assert.ok(/ended with code 1/.test(lines[0]) && /not digitally signed/.test(lines[0]) && /keeps running without the tray icon/.test(lines[0]), lines[0]);
fake = fakeSpawn();
lines.length = 0;
tray.start(options, base({ spawnFn: fake.spawnFn, log: (line) => lines.push(line) }));
fake.calls[0].child.emit("exit", 0);
assert.strictEqual(lines.length, 0, "closing the icon from its menu is silent");
fake = fakeSpawn();
result = tray.start(options, base({ spawnFn: fake.spawnFn, log: (line) => lines.push(line) }));
result.stop();
fake.calls[0].child.emit("exit", 1);
assert.ok(fake.calls[0].child.killed && lines.length === 0, "stop kills the child and is silent about it");
fake.calls[0].child.emit("error", new Error("spawn powershell.exe ENOENT"));
assert.ok(/could not run PowerShell/.test(lines[0]));

// Zone.Identifier: unblock never throws.
assert.doesNotThrow(() => tray.unblock(path.join(tmp, "nothing.ps1")));

// tray.ps1: every argument the bridge passes is a parameter, and the script avoids what scanners dislike.
const paramBlock = ps1.match(/param\(([\s\S]*?)\n\)/)[1];
for (const flag of Object.keys(named)) {
  assert.ok(new RegExp(`\\$${flag.slice(1)}\\b`).test(paramBlock), `tray.ps1 has a parameter for ${flag}`);
}
assert.ok(!/bypass|encodedcommand|invoke-expression|\biex\b|downloadstring|downloadfile|invoke-webrequest|\bIWR\b/i.test(ps1), "no download or eval patterns");
assert.ok(!/[^\x00-\x7f]/.test(ps1), "tray.ps1 is plain ASCII, so PowerShell 5.1 reads it without a byte order mark");
assert.ok(!ps1.includes("\u2014"), "no em dashes");
for (const text of ["Open dashboard", "Copy loader line", "Show log", "Restart bridge", "Stop Superbase", "Update available"]) assert.ok(ps1.includes(text), `the menu has ${text}`);
assert.ok(ps1.includes("-not (Get-Process -Id $BridgePid)"), "it closes when the bridge is gone");
assert.ok(ps1.includes("Stop-Process -Id $BridgePid") && /"restart"\)/.test(ps1), "stop and restart are done by the tray itself");
assert.ok(ps1.includes("SUPERBASE_TRAY_TOKEN") && ps1.includes("x-bridge-token"), "the token comes from the environment");
assert.ok(ps1.includes("assets/icon.png") || ps1.includes("IconFile"), "it uses the Superbase icon file");
assert.ok(ps1.includes("$icon.Text = \"Superbase\"") && ps1.includes("Substring(0, 60)"), "the tooltip is kept under 63 characters");
// A PowerShell trap: in `'"' + $x + '"', 'restart'` the comma binds first. The arguments must be built from variables.
assert.ok(/\$cliArg = '"' \+ \$CliPath \+ '"'/.test(ps1) && /@\(\$cliArg, "restart"\)/.test(ps1));
const open = (ps1.match(/\{/g) || []).length;
const close = (ps1.match(/\}/g) || []).length;
assert.strictEqual(open, close, "braces are balanced");
assert.strictEqual((ps1.match(/\(/g) || []).length, (ps1.match(/\)/g) || []).length, "parentheses are balanced");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL TRAY CHECKS PASSED");
