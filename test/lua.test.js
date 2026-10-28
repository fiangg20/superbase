"use strict";

// Static checks for the Lua files. There is no Lua runtime in the test setup, so this catches
// the mistakes that are easy to make by hand: unbalanced blocks, missing or unused snippets and
// version numbers that drifted apart.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LUA_DIR = path.join(ROOT, "src", "lua");

// Removes comments and string contents, so keywords inside them are not counted.
function strip(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    let match;
    if ((match = rest.match(/^--\[(=*)\[/))) {
      const close = `]${match[1]}]`;
      const end = source.indexOf(close, i);
      i = end < 0 ? source.length : end + close.length;
    } else if (rest.startsWith("--")) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
    } else if ((match = rest.match(/^\[(=*)\[/))) {
      const close = `]${match[1]}]`;
      const end = source.indexOf(close, i);
      i = end < 0 ? source.length : end + close.length;
      out += '""';
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") j += 1;
        j += 1;
      }
      i = j + 1;
      out += '""';
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

// Every function, do and if needs an end. repeat/until and elseif need none.
function balance(source) {
  const words = strip(source).match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  let opens = 0;
  let ends = 0;
  for (const word of words) {
    if (word === "function" || word === "do" || word === "if") opens += 1;
    else if (word === "end") ends += 1;
  }
  return { opens, ends };
}

function brackets(source) {
  const text = strip(source);
  const count = (char) => text.split(char).length - 1;
  return [["(", ")"], ["{", "}"], ["[", "]"]].map(([open, close]) => [open, count(open), count(close)]);
}

const snippetFiles = fs
  .readdirSync(LUA_DIR)
  .filter((name) => name.endsWith(".lua"))
  .map((name) => path.join(LUA_DIR, name));
const files = [...snippetFiles, path.join(ROOT, "roblox", "client.lua")];

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const { opens, ends } = balance(source);
  assert.strictEqual(opens, ends, `${path.relative(ROOT, file)}: ${opens} blocks opened but ${ends} closed`);
  for (const [char, opening, closing] of brackets(source)) {
    assert.strictEqual(opening, closing, `${path.relative(ROOT, file)}: unbalanced ${char}`);
  }
}

// Snippets start with their header and do not use globals that only exist in the client.
for (const file of snippetFiles) {
  const source = fs.readFileSync(file, "utf8");
  const name = path.basename(file);
  assert.ok(source.startsWith("-- Superbase snippet:"), `${name} needs its header comment`);
  assert.ok(!/\bCONFIG\b/.test(strip(source)), `${name} must not use CONFIG`);
}

// Every snippet the MCP server runs exists, and every snippet file is used.
const server = fs.readFileSync(path.join(ROOT, "src", "mcp-server.js"), "utf8");
const used = new Set([...server.matchAll(/runSnippet\(\s*"([a-z_]+)"/g)].map((match) => match[1]));
const present = new Set(snippetFiles.map((file) => path.basename(file, ".lua")));
for (const name of used) assert.ok(present.has(name), `the MCP server runs ${name}.lua, which does not exist`);
for (const name of present) assert.ok(used.has(name), `${name}.lua is never used by the MCP server`);

// The client, the bridge, the MCP server and package.json agree on the version.
const client = fs.readFileSync(path.join(ROOT, "roblox", "client.lua"), "utf8");
const bridge = fs.readFileSync(path.join(ROOT, "src", "bridge.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const versions = {
  client: client.match(/Version = "([^"]+)"/)[1],
  bridge: bridge.match(/const VERSION = "([^"]+)"/)[1],
  server: server.match(/const VERSION = "([^"]+)"/)[1],
  package: pkg.version,
};
assert.strictEqual(new Set(Object.values(versions)).size, 1, `versions differ: ${JSON.stringify(versions)}`);

console.log(`ALL LUA CHECKS PASSED (${files.length} files, ${used.size} snippets, version ${versions.package})`);
