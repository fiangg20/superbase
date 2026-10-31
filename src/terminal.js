"use strict";

// Colors, symbols and a title box for the terminal output of the bridge and the installer.
// No dependencies. Everything falls back to plain ASCII when the terminal is too old for the symbols.

function supportsUnicode(platform, env) {
  if (platform === "win32") return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON" || env.VSCODE_INJECTION);
  return env.TERM !== "linux" && env.TERM !== "dumb";
}

function makeUi(color, unicode) {
  const wrap = (open, close) => (text) => (color ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
  return {
    color,
    unicode,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    sym: unicode
      ? { on: "◉", off: "○", cursor: "❯", ok: "✔", warn: "▲", fail: "✖", dot: "·", live: "●", rule: "─", tl: "╭", tr: "╮", bl: "╰", br: "╯", v: "│", more: "…" }
      : { on: "[x]", off: "[ ]", cursor: ">", ok: "+", warn: "!", fail: "x", dot: "-", live: "*", rule: "-", tl: "+", tr: "+", bl: "+", br: "+", v: "|", more: "..." },
  };
}

// A box with a bold title and a dim subtitle. `out` receives one line at a time.
function banner(ui, title, subtitle, out) {
  const width = Math.max(46, String(title).length + 8, String(subtitle).length + 8);
  const row = (text, style) => {
    const plain = String(text);
    const pad = " ".repeat(Math.max(0, width - 6 - plain.length));
    return `  ${ui.cyan(ui.sym.v)}  ${style ? style(plain) : plain}${pad}  ${ui.cyan(ui.sym.v)}`;
  };
  out("");
  out(`  ${ui.cyan(ui.sym.tl + ui.sym.rule.repeat(width - 2) + ui.sym.tr)}`);
  out(row(title, ui.bold));
  out(row(subtitle, ui.dim));
  out(`  ${ui.cyan(ui.sym.bl + ui.sym.rule.repeat(width - 2) + ui.sym.br)}`);
  out("");
}

// Keeps the end of a long text, which is the interesting part of a path.
function shorten(text, room, ui) {
  if (text.length <= room) return text;
  return ui.sym.more + text.slice(-(room - ui.sym.more.length));
}

module.exports = { supportsUnicode, makeUi, banner, shorten };
