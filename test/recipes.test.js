"use strict";

// Recipes: the folder, the header, saving (with its limits) and the built-in recipes.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const recipes = require("../src/recipes");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-recipes-"));
const root = path.join(__dirname, "..");

// The folder: the setting, or recipes/ next to src/.
assert.strictEqual(recipes.recipesDir({ recipesDir: "" }, "/x"), path.join("/x", "recipes"));
assert.strictEqual(recipes.recipesDir({ recipesDir: dir }, "/x"), path.resolve(dir));

// Names.
for (const good of ["a", "list-remotes", "dump_stats", "r2d2", "0day"]) assert.doesNotThrow(() => recipes.checkName(good), good);
for (const bad of ["", "A", "a b", "../x", "a/b", "a\\b", ".hidden", "-a", "_a", "a.lua", "x".repeat(61), null, undefined, 5]) {
  assert.throws(() => recipes.checkName(bad), recipes.RecipeError, `refused: ${String(bad)}`);
}

// An empty folder, and a folder that does not exist.
assert.deepStrictEqual(recipes.list(dir), []);
assert.deepStrictEqual(recipes.list(path.join(dir, "missing")), []);

// Saving writes a header in front of plain code.
let saved = recipes.save(dir, "hello", "return { hi = args.name }", { title: "Hello", description: "Says hi.", args: "name (string)" });
assert.strictEqual(saved.saved, "hello");
assert.strictEqual(fs.readFileSync(path.join(dir, "hello.lua"), "utf8"), "-- Recipe: Hello\n-- Description: Says hi.\n-- Args: name (string)\nreturn { hi = args.name }\n");
let item = recipes.list(dir)[0];
assert.deepStrictEqual({ name: item.name, title: item.title, description: item.description, args: item.args }, { name: "hello", title: "Hello", description: "Says hi.", args: "name (string)" });
let read = recipes.read(dir, "hello");
assert.ok(read.source.includes("return { hi = args.name }"));

// Code that already has a header is kept as it is.
recipes.save(dir, "own", "-- Recipe: Mine\n-- Description: Mine.\nreturn 1");
assert.strictEqual(fs.readFileSync(path.join(dir, "own.lua"), "utf8"), "-- Recipe: Mine\n-- Description: Mine.\nreturn 1\n");
assert.strictEqual(recipes.read(dir, "own").title, "Mine");

// An imported recipe has a Source line in front. With its own header nothing is added, without one a header is put on top.
recipes.save(dir, "shared", "-- Source: https://raw.githubusercontent.com/o/r/main/a.lua\n-- Recipe: Shared\n-- Description: From the web.\nreturn 1");
const shared = fs.readFileSync(path.join(dir, "shared.lua"), "utf8");
assert.strictEqual(shared.split("\n").filter((line) => /^-- Recipe:/.test(line)).length, 1, "no second header");
assert.strictEqual(recipes.read(dir, "shared").title, "Shared");
recipes.save(dir, "shared-bare", "-- Source: https://gist.githubusercontent.com/u/id/raw\nreturn 2", { title: "Bare", description: "Imported." });
const bare = fs.readFileSync(path.join(dir, "shared-bare.lua"), "utf8");
assert.ok(bare.startsWith("-- Recipe: Bare\n-- Description: Imported.\n"), bare);
assert.ok(bare.includes("-- Source: https://gist.githubusercontent.com/u/id/raw\nreturn 2"), "the Source line stays with the code");
assert.strictEqual(recipes.read(dir, "shared-bare").title, "Bare");

// A header cannot be broken out of with a line break in the title.
recipes.save(dir, "tricky", "return 1", { title: "A\nreturn os.exit()", description: "B\r\nC" });
const tricky = fs.readFileSync(path.join(dir, "tricky.lua"), "utf8");
assert.ok(tricky.split("\n").slice(0, 3).every((line) => line.startsWith("-- ")), tricky);

// A name that is not given a title uses the name.
recipes.save(dir, "plain", "return 1");
assert.strictEqual(recipes.read(dir, "plain").title, "plain");

// Existing recipes need overwrite.
assert.throws(() => recipes.save(dir, "hello", "return 2"), /overwrite/);
recipes.save(dir, "hello", "return 2", { overwrite: true });
assert.ok(recipes.read(dir, "hello").source.includes("return 2"));

// Limits and wrong input.
assert.throws(() => recipes.save(dir, "big", "x".repeat(recipes.MAX_SOURCE_BYTES + 1)), /at most/);
assert.throws(() => recipes.save(dir, "empty", "   \n"), /non-empty/);
assert.throws(() => recipes.save(dir, "nothing", undefined), /non-empty/);
assert.throws(() => recipes.save(dir, "../escape", "return 1"), recipes.RecipeError);
assert.throws(() => recipes.read(dir, "../package"), recipes.RecipeError);
assert.throws(() => recipes.read(dir, "missing"), /no recipe called/);
assert.ok(!fs.existsSync(path.join(dir, "..", "escape.lua")));

// Other files in the folder are not recipes.
fs.writeFileSync(path.join(dir, "notes.txt"), "x");
fs.writeFileSync(path.join(dir, "Bad Name.lua"), "return 1");
assert.deepStrictEqual(recipes.list(dir).map((entry) => entry.name), ["hello", "own", "plain", "shared-bare", "shared", "tricky"]);

// The header parser stops at the first line of code.
assert.deepStrictEqual(recipes.parseHeader("-- Recipe: A\n-- Description: B\n-- Args: C\nreturn 1\n-- Recipe: later"), { title: "A", description: "B", args: "C" });
assert.deepStrictEqual(recipes.parseHeader("return 1"), { title: "", description: "", args: "" });

fs.rmSync(dir, { recursive: true, force: true });

// The built-in recipes: every one has a full header, a valid name and Lua that compiles.
const builtin = recipes.list(path.join(root, "recipes"));
assert.ok(builtin.length >= 5, "at least five built-in recipes");
for (const recipe of builtin) {
  assert.ok(recipe.title && recipe.title !== recipe.name, `${recipe.name} has a title`);
  assert.ok(recipe.description.length > 10, `${recipe.name} has a description`);
  assert.ok(recipe.args.length > 0, `${recipe.name} says what args it takes`);
  const source = fs.readFileSync(path.join(root, "recipes", `${recipe.name}.lua`), "utf8");
  assert.ok(!source.includes("\u2014"), `${recipe.name} has no em dash`);
  assert.ok(/\breturn\b/.test(source), `${recipe.name} returns a value`);
}

// Compile them with a Lua that is installed here, when there is one (the real check is in the runtime test).
for (const name of ["luac5.4", "luac5.3", "luac", "texluac"]) {
  if (spawnSync(name, ["-v"], { encoding: "utf8" }).error) continue;
  for (const recipe of builtin) {
    const result = spawnSync(name, ["-p", path.join(root, "recipes", `${recipe.name}.lua`)], { encoding: "utf8" });
    assert.strictEqual(result.status, 0, `${recipe.name} does not compile: ${result.stderr}`);
  }
  break;
}

console.log(`ALL RECIPE CHECKS PASSED (${builtin.length} built-in recipes)`);
