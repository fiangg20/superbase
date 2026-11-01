"use strict";

// Settings: environment variables, superbase.config.json and the defaults, in that order.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadSettings, stateDir, SPEC } = require("../src/config");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-config-"));
const file = path.join(dir, "superbase.config.json");
const write = (value) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));

// Defaults, with no file.
let s = loadSettings({}, dir);
assert.strictEqual(s.port, 9731);
assert.strictEqual(s.token, "");
assert.strictEqual(s.autostart, true);
assert.strictEqual(s.updateCheck, true);
assert.strictEqual(s.plain, false);
assert.strictEqual(s.file, null);
assert.deepStrictEqual(s.warnings, []);
assert.strictEqual(s.sources.port, "default");

// The file in the Superbase folder is read.
write({ port: 9800, autostart: false, screenshotMaxWidth: 800, recipesDir: "/tmp/r" });
s = loadSettings({}, dir);
assert.strictEqual(s.port, 9800);
assert.strictEqual(s.autostart, false);
assert.strictEqual(s.screenshotMaxWidth, 800);
assert.strictEqual(s.recipesDir, "/tmp/r");
assert.strictEqual(s.file, file);
assert.strictEqual(s.sources.port, "file");
assert.deepStrictEqual(s.warnings, []);

// The environment wins over the file, and the old BRIDGE_ names still work.
s = loadSettings({ SUPERBASE_PORT: "9900" }, dir);
assert.strictEqual(s.port, 9900);
assert.strictEqual(s.sources.port, "env");
s = loadSettings({ BRIDGE_PORT: "9901", BRIDGE_TOKEN: "x".repeat(20) }, dir);
assert.strictEqual(s.port, 9901);
assert.strictEqual(s.token, "x".repeat(20));
s = loadSettings({ SUPERBASE_AUTOSTART: "1" }, dir);
assert.strictEqual(s.autostart, true, "an environment variable overrides false from the file");

// Booleans can be written the usual ways.
for (const [text, expected] of [["0", false], ["false", false], ["off", false], ["no", false], ["1", true], ["true", true], ["on", true], ["yes", true]]) {
  assert.strictEqual(loadSettings({ SUPERBASE_PLAIN: text }, dir).plain, expected, `SUPERBASE_PLAIN=${text}`);
}

// A bad value falls back and says so, and never throws.
write({ port: "abc", autostart: "maybe", pingMs: 1, nothing: true, screenshotMaxWidth: 99999 });
s = loadSettings({ SUPERBASE_PORT: "70000" }, dir);
assert.strictEqual(s.port, 9731);
assert.strictEqual(s.autostart, true);
assert.strictEqual(s.pingMs, SPEC.pingMs[3]);
assert.strictEqual(s.screenshotMaxWidth, 1280);
const text = s.warnings.join("\n");
assert.ok(text.includes("SUPERBASE_PORT=70000"), text);
assert.ok(text.includes('"autostart"'), text);
assert.ok(text.includes('Unknown setting "nothing"'), text);

// A file that is not JSON, or not an object, is reported and ignored.
write("{ not json");
s = loadSettings({}, dir);
assert.strictEqual(s.port, 9731);
assert.ok(s.warnings.length === 1 && s.warnings[0].includes("superbase.config.json"), s.warnings.join("|"));
write("[1,2]");
assert.strictEqual(loadSettings({}, dir).warnings.length, 1);

// $schema and _comment keys are allowed.
write({ $schema: "x", _comment: "hello", port: 9810 });
s = loadSettings({}, dir);
assert.strictEqual(s.port, 9810);
assert.deepStrictEqual(s.warnings, []);

// SUPERBASE_CONFIG points at another file, or switches the file off.
const other = path.join(dir, "other.json");
fs.writeFileSync(other, JSON.stringify({ port: 9820 }));
assert.strictEqual(loadSettings({ SUPERBASE_CONFIG: other }, dir).port, 9820);
assert.strictEqual(loadSettings({ SUPERBASE_CONFIG: "none" }, dir).port, 9731);
assert.strictEqual(loadSettings({ SUPERBASE_CONFIG: "off" }, dir).file, null);

// A short token is flagged.
write({ token: "short" });
assert.ok(loadSettings({}, dir).warnings.some((warning) => warning.includes("shorter than 16")));

// The state folder.
assert.strictEqual(stateDir({}, dir), path.join(dir, ".superbase"));
assert.strictEqual(stateDir({ SUPERBASE_HOME: dir }, "/elsewhere"), path.resolve(dir));

// The example file in the repository is valid and complete.
const example = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "superbase.config.example.json"), "utf8"));
assert.deepStrictEqual(Object.keys(example).sort(), Object.keys(SPEC).sort());
const check = loadSettings({ SUPERBASE_CONFIG: path.join(__dirname, "..", "superbase.config.example.json") }, dir);
assert.deepStrictEqual(check.warnings, [], "the example config has no warnings");

fs.rmSync(dir, { recursive: true, force: true });
console.log("ALL CONFIG CHECKS PASSED");
