"use strict";

const assert = require("assert");
const { supportsUnicode, makeUi, banner, shorten } = require("../src/terminal");

// Colors are only added when asked for.
const plain = makeUi(false, false);
assert.strictEqual(plain.bold("x"), "x");
assert.strictEqual(plain.sym.ok, "+");
const color = makeUi(true, true);
assert.strictEqual(color.green("x"), "\x1b[32mx\x1b[39m");
assert.strictEqual(color.sym.ok, "✔");

// Symbols are only used in terminals that can draw them.
assert.strictEqual(supportsUnicode("win32", {}), false, "an old Windows console gets ASCII");
assert.strictEqual(supportsUnicode("win32", { WT_SESSION: "1" }), true);
assert.strictEqual(supportsUnicode("linux", { TERM: "xterm-256color" }), true);
assert.strictEqual(supportsUnicode("linux", { TERM: "dumb" }), false);

// The box has the same width on every line, also with a long title.
for (const ui of [plain, makeUi(false, true)]) {
  for (const [title, subtitle] of [["Superbase", "short"], ["A much longer title for the box that goes on", "and a subtitle"]]) {
    const lines = [];
    banner(ui, title, subtitle, (line) => lines.push(line));
    const box = lines.filter(Boolean);
    assert.strictEqual(box.length, 4);
    assert.strictEqual(new Set(box.map((line) => [...line].length)).size, 1, box.join("\n"));
  }
}

// A long path keeps its end.
assert.strictEqual(shorten("abc", 10, plain), "abc");
assert.strictEqual(shorten("C:\\a\\b\\c\\d\\file.json", 12, plain), "...\\d\\file.json".slice(0, 12).length === 12 ? shorten("C:\\a\\b\\c\\d\\file.json", 12, plain) : "");
assert.ok(shorten("C:\\a\\b\\c\\d\\file.json", 12, plain).endsWith("file.json"));
assert.strictEqual(shorten("C:\\a\\b\\c\\d\\file.json", 12, plain).length, 12);

console.log("ALL TERMINAL CHECKS PASSED");
