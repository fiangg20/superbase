"use strict";

// Recipes are Lua files in the recipes folder that the AI (or you) can run by name. A recipe starts with a header
// of comment lines and then plain Lua code. The code runs like a snippet: a table named args holds the arguments,
// and the code returns the result.
//
//   -- Recipe: List remotes
//   -- Description: Lists every RemoteEvent and RemoteFunction.
//   -- Args: limit (number, default 100)
//   local limit = args.limit or 100
//   ...

const fs = require("fs");
const path = require("path");
const { ROOT } = require("./config");

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const MAX_SOURCE_BYTES = 100 * 1024;
const MAX_RECIPES = 500;

class RecipeError extends Error {}

function recipesDir(settings, root = ROOT) {
  return settings && settings.recipesDir ? path.resolve(settings.recipesDir) : path.join(root, "recipes");
}

function checkName(name) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new RecipeError("A recipe name uses lowercase letters, digits, - and _, starts with a letter or digit and has at most 60 characters.");
  }
  return name;
}

function fileFor(dir, name) {
  return path.join(dir, `${checkName(name)}.lua`);
}

// Reads Recipe, Description and Args from the comment lines at the top of the file.
function parseHeader(source) {
  const header = { title: "", description: "", args: "" };
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^--\s*(Recipe|Description|Args)\s*:\s*(.*)$/i);
    if (match) {
      header[{ recipe: "title", description: "description", args: "args" }[match[1].toLowerCase()]] = match[2].trim();
    } else if (!line.startsWith("--") && line.trim() !== "") {
      break;
    }
  }
  return header;
}

function list(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const items = [];
  for (const file of names.sort()) {
    const name = file.replace(/\.lua$/, "");
    if (!file.endsWith(".lua") || !NAME_PATTERN.test(name)) continue;
    if (items.length >= MAX_RECIPES) break;
    try {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      const header = parseHeader(source);
      items.push({ name, title: header.title || name, description: header.description, args: header.args, bytes: Buffer.byteLength(source) });
    } catch {
      // An unreadable file is skipped.
    }
  }
  return items;
}

function read(dir, name) {
  const file = fileFor(dir, name);
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    throw new RecipeError(`There is no recipe called '${name}'. Use the list action to see the recipes.`);
  }
  const header = parseHeader(source);
  return { name, title: header.title || name, description: header.description, args: header.args, source };
}

const oneLine = (text) => String(text || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);

// Writes a recipe. An existing recipe is only replaced with overwrite true.
function save(dir, name, code, { title, description, args, overwrite = false } = {}) {
  const file = fileFor(dir, name);
  if (typeof code !== "string" || code.trim() === "") throw new RecipeError("'code' must be a non-empty string.");
  if (Buffer.byteLength(code) > MAX_SOURCE_BYTES) throw new RecipeError(`A recipe can be at most ${MAX_SOURCE_BYTES / 1024} KB.`);
  if (fs.existsSync(file) && !overwrite) {
    throw new RecipeError(`A recipe called '${name}' already exists. Pass overwrite true to replace it, or pick another name.`);
  }

  // Keep the code as it is, and put the header in front unless the code already starts with one.
  // A "-- Source:" line in front (written by the import) does not count as a header.
  const hasHeader = /^(--\s*Source\s*:[^\n]*\n)?--\s*Recipe\s*:/i.test(code.trimStart());
  const header = hasHeader
    ? ""
    : [`-- Recipe: ${oneLine(title) || name}`, `-- Description: ${oneLine(description)}`, `-- Args: ${oneLine(args)}`, ""].join("\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${header}${code.replace(/\s+$/, "")}\n`);
  return { saved: name, file };
}

module.exports = { recipesDir, list, read, save, parseHeader, checkName, RecipeError, NAME_PATTERN, MAX_SOURCE_BYTES };
