"use strict";

// MCP prompts: the list, the texts and the argument checks.

const assert = require("assert");
const prompts = require("../src/prompts");

const listed = prompts.list();
assert.deepStrictEqual(listed.map((prompt) => prompt.name), ["diagnose", "find-code", "explain-game", "trace-remote", "performance-check", "why-error"]);
for (const prompt of listed) {
  assert.ok(prompt.title && prompt.description.length > 20, `${prompt.name} has a title and a description`);
  assert.ok(Array.isArray(prompt.arguments), `${prompt.name} lists its arguments`);
  assert.strictEqual(prompt.text, undefined, "the text builder does not leak into the list");
  assert.ok(!/\u2014/.test(JSON.stringify(prompt)), "no em dashes");
}

// Every prompt builds a message for the AI that names real Superbase tools.
const toolNames = new Set([
  "roblox_status", "get_errors", "get_logs", "search_scripts", "get_script_source", "stats", "semantic_search", "get_game_info", "get_hierarchy",
  "list_scripts", "find_instances", "remote_spy", "gui_interact",
]);
for (const prompt of listed) {
  const args = Object.fromEntries(prompt.arguments.map((argument) => [argument.name, "x"]));
  const result = prompts.get(prompt.name, args);
  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.messages[0].role, "user");
  assert.strictEqual(result.messages[0].content.type, "text");
  const text = result.messages[0].content.text;
  const mentioned = text.match(/\b[a-z]+_[a-z_]+\b/g) || [];
  assert.ok(mentioned.some((name) => toolNames.has(name)), `${prompt.name} mentions a tool`);
  for (const name of mentioned) if (/^(get|list|find|search|roblox|remote|gui|semantic)_/.test(name)) assert.ok(toolNames.has(name), `${prompt.name} mentions ${name}, which is not a tool`);
}

// Arguments end up in the text, are cut to one line and to 500 characters.
assert.ok(prompts.get("diagnose", { focus: "the shop\n\ndoes not open" }).messages[0].content.text.includes("the shop does not open"));
assert.ok(!prompts.get("diagnose", {}).messages[0].content.text.includes("suspects"), "no focus, no line about it");
assert.ok(prompts.get("find-code", { what: "x".repeat(900) }).messages[0].content.text.includes("x".repeat(500)));
assert.ok(!prompts.get("find-code", { what: "x".repeat(900) }).messages[0].content.text.includes("x".repeat(501)));
assert.ok(prompts.get("trace-remote", { remote: "Buy" }).messages[0].content.text.includes('only set to "Buy"'));
assert.ok(prompts.get("why-error", { error: "attempt to index nil" }).messages[0].content.text.includes("attempt to index nil"));

// Problems.
assert.throws(() => prompts.get("find-code", {}), (error) => error instanceof prompts.PromptError && /needs the argument 'what'/.test(error.message));
assert.throws(() => prompts.get("find-code", { what: "   " }), prompts.PromptError, "a blank required argument counts as missing");
assert.throws(() => prompts.get("nope", {}), (error) => error instanceof prompts.PromptError && /Unknown prompt/.test(error.message));
assert.doesNotThrow(() => prompts.get("explain-game"), "arguments are optional for a prompt without any");
assert.doesNotThrow(() => prompts.get("diagnose", [1, 2]), "an array instead of an object is ignored");

console.log("ALL PROMPT CHECKS PASSED");
