"use strict";

// The loader files: the one line, the robust loader and the npm run loader command.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { oneLiner, render, LOADER_FILE, AUTOEXEC_NAME } = require("../src/loader");
const { main } = require("../scripts/loader");

assert.strictEqual(oneLiner(9731), 'loadstring(game:HttpGet("http://127.0.0.1:9731/client.lua"))()');
assert.strictEqual(oneLiner(9800, "192.168.1.5"), 'loadstring(game:HttpGet("http://192.168.1.5:9800/client.lua"))()');
assert.strictEqual(AUTOEXEC_NAME, "superbase-loader.lua");

const template = fs.readFileSync(LOADER_FILE, "utf8");
assert.ok(template.includes('local BRIDGE = "127.0.0.1:9731"'));
assert.ok(render(9731) === template, "the default address changes nothing");
const custom = render(9800, "10.0.0.4");
assert.ok(custom.includes('local BRIDGE = "10.0.0.4:9800"') && !custom.includes("9731"));
assert.strictEqual(custom.split("\n").length, template.split("\n").length, "only the address line changes");

// The autoexec copy tells the client that the executor runs the loader again after a teleport.
assert.ok(template.includes("local AUTOEXEC = false"), "the shared loader is not marked as autoexec");
const marked = render(9731, "127.0.0.1", undefined, "", { autoexec: true });
assert.ok(marked.includes("local AUTOEXEC = true") && !marked.includes("local AUTOEXEC = false"), "the autoexec copy is marked");
assert.strictEqual(marked.split("\n").length, template.split("\n").length, "only the flag line changes");
assert.ok(template.includes("__SuperbaseAutoexec"), "the loader sets the marker for the client");

const broken = path.join(require("os").tmpdir(), `superbase-loader-test-${process.pid}.lua`);
fs.writeFileSync(broken, "print(1)");
assert.throws(() => render(1, "x", broken), /no BRIDGE line/);
fs.unlinkSync(broken);

// The command.
const run = (args, env = {}) => {
  let text = "";
  const code = main(args, { SUPERBASE_CONFIG: "none", ...env }, (chunk) => (text += chunk));
  return { code, text };
};
assert.strictEqual(run(["--one-line"]).text, `${oneLiner(9731)}\n`);
assert.strictEqual(run(["--one-line"], { SUPERBASE_PORT: "9900" }).text, `${oneLiner(9900)}\n`, "the port comes from the settings");
assert.ok(run(["--port", "9801"]).text.includes("127.0.0.1:9801"));
assert.ok(run(["--host", "10.1.1.1", "--one-line"]).text.includes("10.1.1.1"));
assert.strictEqual(run(["--port", "0"]).code, 2);
assert.strictEqual(run(["--wat"]).code, 2);

console.log("ALL LOADER CHECKS PASSED");
