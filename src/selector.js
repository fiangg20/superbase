"use strict";

// Parses a small CSS-like selector for find_instances into steps that the Lua side evaluates.
//
// Grammar:
//   selector   = [">"] compound { combinator compound }
//   combinator = whitespace (descendant) | ">" (direct child)
//   compound   = [type] { "#" name | "[" attribute "]" }
//   type       = class name (base classes match too) or "*"
//   name       = bare word or quoted string, matched exactly
//   attribute  = property [operator value]
//   operator   = "=" | "!=" | "*=" (contains) | "^=" (starts with) | "$=" (ends with)
//              | "<" | "<=" | ">" | ">="
//   value      = quoted string, number, true, false or a bare word
//
// Examples: "RemoteEvent", "Model > Part", "Part[Anchored=false]", "TextButton#Play",
//           "Frame TextLabel[Text*='coins']", "> Workspace > Map".

const MAX_LENGTH = 500;
const MAX_STEPS = 8;
const MAX_ATTRIBUTES = 6;
const OPERATORS = ["!=", "*=", "^=", "$=", "<=", ">=", "=", "<", ">"];

class SelectorError extends Error {}

function parseSelector(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new SelectorError("The selector must be a non-empty string.");
  }
  if (input.length > MAX_LENGTH) {
    throw new SelectorError(`The selector is longer than ${MAX_LENGTH} characters.`);
  }

  const length = input.length;
  let position = 0;

  const fail = (message) => {
    throw new SelectorError(`${message} at position ${position + 1} of "${input}".`);
  };

  const skipSpaces = () => {
    let skipped = false;
    while (position < length && /\s/.test(input[position])) {
      position += 1;
      skipped = true;
    }
    return skipped;
  };

  const readQuoted = () => {
    const quote = input[position];
    position += 1;
    let text = "";
    while (position < length && input[position] !== quote) {
      if (input[position] === "\\" && position + 1 < length) {
        position += 1;
      }
      text += input[position];
      position += 1;
    }
    if (position >= length) fail("Unterminated quote");
    position += 1;
    return text;
  };

  const readWord = (pattern) => {
    const start = position;
    while (position < length && pattern.test(input[position])) {
      position += 1;
    }
    return input.slice(start, position);
  };

  const readAttribute = () => {
    skipSpaces();
    const prop = readWord(/[A-Za-z0-9_]/);
    if (prop === "") fail("Expected a property name");
    skipSpaces();

    if (input[position] === "]") {
      position += 1;
      return { prop, op: "truthy", value: null };
    }

    const op = OPERATORS.find((candidate) => input.startsWith(candidate, position));
    if (!op) fail("Expected an operator or ']'");
    position += op.length;
    skipSpaces();

    let value;
    if (input[position] === '"' || input[position] === "'") {
      value = readQuoted();
    } else {
      const word = readWord(/[^\]\s]/);
      if (word === "") fail("Expected a value");
      if (/^-?\d+(\.\d+)?$/.test(word)) value = Number(word);
      else if (word === "true") value = true;
      else if (word === "false") value = false;
      else value = word;
    }

    skipSpaces();
    if (input[position] !== "]") fail("Expected ']'");
    position += 1;
    return { prop, op, value };
  };

  const readCompound = (combinator) => {
    const step = { combinator, type: null, name: null, attrs: [] };

    if (input[position] === "*") {
      step.type = "*";
      position += 1;
    } else if (/[A-Za-z_]/.test(input[position] || "")) {
      step.type = readWord(/[A-Za-z0-9_]/);
    }

    while (position < length) {
      const char = input[position];
      if (char === "#") {
        position += 1;
        if (step.name !== null) fail("A step can have only one #name");
        if (input[position] === '"' || input[position] === "'") {
          step.name = readQuoted();
        } else {
          step.name = readWord(/[A-Za-z0-9_\-]/);
        }
        if (step.name === "") fail("Expected a name after '#'");
      } else if (char === "[") {
        position += 1;
        if (step.attrs.length >= MAX_ATTRIBUTES) fail(`A step can have at most ${MAX_ATTRIBUTES} attributes`);
        step.attrs.push(readAttribute());
      } else {
        break;
      }
    }

    if (step.type === null && step.name === null && step.attrs.length === 0) {
      fail("Expected a class name, '*', '#name' or '[property]'");
    }
    return step;
  };

  const steps = [];
  skipSpaces();

  let combinator = "descendant";
  if (input[position] === ">") {
    combinator = "child";
    position += 1;
    skipSpaces();
  }

  while (true) {
    steps.push(readCompound(combinator));
    if (steps.length > MAX_STEPS) {
      throw new SelectorError(`The selector has more than ${MAX_STEPS} steps.`);
    }

    const hadSpace = skipSpaces();
    if (position >= length) break;

    if (input[position] === ">") {
      combinator = "child";
      position += 1;
      skipSpaces();
      if (position >= length) fail("Expected a selector after '>'");
    } else if (hadSpace) {
      combinator = "descendant";
    } else {
      fail(`Unexpected character '${input[position]}'`);
    }
  }

  return steps;
}

module.exports = { parseSelector, SelectorError, MAX_STEPS };
