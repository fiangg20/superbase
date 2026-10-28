"use strict";

// Unit test for the selector parser used by find_instances.

const assert = require("assert");
const { parseSelector, SelectorError, MAX_STEPS } = require("../src/selector");

const step = (combinator, type, name = null, attrs = []) => ({ combinator, type, name, attrs });

// A single class, a wildcard, a name, and combinations.
assert.deepStrictEqual(parseSelector("RemoteEvent"), [step("descendant", "RemoteEvent")]);
assert.deepStrictEqual(parseSelector("  Part  "), [step("descendant", "Part")]);
assert.deepStrictEqual(parseSelector("*"), [step("descendant", "*")]);
assert.deepStrictEqual(parseSelector("#Spawn"), [step("descendant", null, "Spawn")]);
assert.deepStrictEqual(parseSelector("TextButton#Play"), [step("descendant", "TextButton", "Play")]);
assert.deepStrictEqual(parseSelector("#'Spawn Point'"), [step("descendant", null, "Spawn Point")]);
assert.deepStrictEqual(parseSelector('Model#"A.B"'), [step("descendant", "Model", "A.B")]);
assert.deepStrictEqual(parseSelector("#Coin-1"), [step("descendant", null, "Coin-1")], "hyphens are allowed in bare names");

// Combinators.
assert.deepStrictEqual(parseSelector("Model Part"), [step("descendant", "Model"), step("descendant", "Part")]);
assert.deepStrictEqual(parseSelector("Model > Part"), [step("descendant", "Model"), step("child", "Part")]);
assert.deepStrictEqual(parseSelector("Model>Part"), [step("descendant", "Model"), step("child", "Part")]);
assert.deepStrictEqual(parseSelector("> Workspace > Map"), [step("child", "Workspace"), step("child", "Map")]);
assert.deepStrictEqual(parseSelector("Frame  >  Frame   TextLabel"), [
  step("descendant", "Frame"),
  step("child", "Frame"),
  step("descendant", "TextLabel"),
]);

// Attributes and every operator.
const attr = (prop, op, value) => ({ prop, op, value });
assert.deepStrictEqual(parseSelector("Part[Anchored=false]"), [step("descendant", "Part", null, [attr("Anchored", "=", false)])]);
assert.deepStrictEqual(parseSelector("Part[Anchored = true]")[0].attrs, [attr("Anchored", "=", true)]);
assert.deepStrictEqual(parseSelector("Part[Transparency>=0.5]")[0].attrs, [attr("Transparency", ">=", 0.5)]);
assert.deepStrictEqual(parseSelector("Part[Size<-2]")[0].attrs, [attr("Size", "<", -2)]);
assert.deepStrictEqual(parseSelector("Part[Reflectance<=1][Name^=Coin]")[0].attrs, [attr("Reflectance", "<=", 1), attr("Name", "^=", "Coin")]);
assert.deepStrictEqual(parseSelector("Part[Name!=Floor]")[0].attrs, [attr("Name", "!=", "Floor")]);
assert.deepStrictEqual(parseSelector("TextLabel[Text*='coins']")[0].attrs, [attr("Text", "*=", "coins")]);
assert.deepStrictEqual(parseSelector('TextLabel[Text$="  x"]')[0].attrs, [attr("Text", "$=", "  x")]);
assert.deepStrictEqual(parseSelector("Part[Visible]")[0].attrs, [{ prop: "Visible", op: "truthy", value: null }]);
assert.deepStrictEqual(parseSelector("Part[Material=Enum.Material.Neon]")[0].attrs, [attr("Material", "=", "Enum.Material.Neon")]);
assert.deepStrictEqual(parseSelector("Part[Count>3]")[0].attrs, [attr("Count", ">", 3)]);
assert.deepStrictEqual(parseSelector("*[Name='a b']#x"), [step("descendant", "*", "x", [attr("Name", "=", "a b")])]);
assert.deepStrictEqual(parseSelector("[Anchored=true]"), [step("descendant", null, null, [attr("Anchored", "=", true)])], "an attribute alone is a valid step");
assert.deepStrictEqual(parseSelector("Frame TextLabel[Text*='it\\'s']")[1].attrs, [attr("Text", "*=", "it's")], "escaped quotes inside quoted values");

// A realistic one.
assert.deepStrictEqual(parseSelector("ScreenGui > Frame TextButton#Play[Visible=true]"), [
  step("descendant", "ScreenGui"),
  step("child", "Frame"),
  step("descendant", "TextButton", "Play", [attr("Visible", "=", true)]),
]);

// Errors: each one is a SelectorError that says where the problem is.
const bad = [
  ["", /non-empty/],
  ["   ", /non-empty/],
  [null, /non-empty/],
  ["Part[", /property name/],
  ["Part[Anchored", /operator/],
  ["Part[Anchored=]", /value/],
  ["Part[Anchored=true", /']'/],
  ["Part[Name='open]", /Unterminated quote/],
  ["Part#", /name after/],
  ["Part#a#b", /only one #name/],
  ["Model >", /after '>'/],
  ["Model > > Part", /Expected a class name/],
  ["Part)", /Unexpected character/],
  ["Part$", /Unexpected character/],
  ["#", /name after/],
  ["Part[A=1][B=2][C=3][D=4][E=5][F=6][G=7]", /at most 6 attributes/],
  ["A > B > C > D > E > F > G > H > I", /more than 8 steps/],
  ["x".repeat(501), /longer than 500/],
];
for (const [input, pattern] of bad) {
  assert.throws(() => parseSelector(input), (error) => error instanceof SelectorError && pattern.test(error.message), `expected a SelectorError matching ${pattern} for ${JSON.stringify(input).slice(0, 40)}`);
}
assert.throws(() => parseSelector("Part[Anchored"), /at position \d+ of "Part\[Anchored"/, "the message includes the position and the input");

// The limit is exactly eight steps.
assert.strictEqual(parseSelector(Array.from({ length: MAX_STEPS }, (_, i) => `N${i}`).join(" > ")).length, MAX_STEPS);

console.log("ALL SELECTOR CHECKS PASSED");
