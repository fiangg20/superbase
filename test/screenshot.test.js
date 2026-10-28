"use strict";

// Unit test for the screenshot module. PowerShell is replaced by a fake runner, so this
// runs on any operating system. The real capture needs Windows and a running Roblox window.

const assert = require("assert");
const { captureRobloxWindow, ScreenshotError, clampWidth, POWERSHELL_SCRIPT } = require("../src/screenshot");

const answer = (object, extra = {}) => async () => ({ stdout: `${JSON.stringify(object)}\r\n`, stderr: "", ...extra });

async function failsWith(promise, status, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ScreenshotError, `expected a ScreenshotError, got ${error && error.constructor.name}: ${error && error.message}`);
    assert.strictEqual(error.status, status, error.message);
    assert.ok(pattern.test(error.message), error.message);
    return true;
  });
}

async function main() {
  // Width clamping.
  assert.strictEqual(clampWidth(undefined), 1280);
  assert.strictEqual(clampWidth("abc"), 1280);
  assert.strictEqual(clampWidth(10), 320);
  assert.strictEqual(clampWidth(99999), 1920);
  assert.strictEqual(clampWidth("800"), 800);
  assert.strictEqual(clampWidth(800.6), 801);

  // Not Windows: a clear 501 without starting anything.
  let started = false;
  await failsWith(captureRobloxWindow({ platform: "linux", run: async () => { started = true; return { stdout: "", stderr: "" }; } }), 501, /only supported on Windows/);
  await failsWith(captureRobloxWindow({ platform: "darwin" }), 501, /Windows/);
  assert.strictEqual(started, false, "nothing runs on other platforms");

  // Success: the result is passed through and the options travel as environment variables.
  let seen = null;
  const shot = await captureRobloxWindow({
    platform: "win32",
    maxWidth: 99999,
    focus: true,
    run: async (script, env, timeoutMs) => {
      seen = { script, env, timeoutMs };
      return { stdout: `noise before\r\n${JSON.stringify({ ok: true, mimeType: "image/jpeg", width: 1920, height: 1080, title: "Roblox", data: "QUJD" })}\r\n`, stderr: "" };
    },
  });
  assert.deepStrictEqual(shot, { mimeType: "image/jpeg", data: "QUJD", width: 1920, height: 1080, title: "Roblox" });
  assert.strictEqual(seen.script, POWERSHELL_SCRIPT);
  assert.deepStrictEqual(seen.env, { SB_MAX_WIDTH: "1920", SB_FOCUS: "1" });
  assert.strictEqual(typeof seen.timeoutMs, "number");

  const plain = await captureRobloxWindow({ platform: "win32", run: async (script, env) => ({ stdout: JSON.stringify({ ok: true, mimeType: "image/jpeg", width: 1, height: 1, data: "QQ==", env }), stderr: "" }) });
  assert.strictEqual(plain.title, null, "a missing title becomes null");
  assert.deepStrictEqual(seen.env, { SB_MAX_WIDTH: "1920", SB_FOCUS: "1" });
  let defaults = null;
  await captureRobloxWindow({ platform: "win32", run: async (script, env) => { defaults = env; return { stdout: JSON.stringify({ ok: true, mimeType: "image/jpeg", width: 1, height: 1, data: "" }), stderr: "" }; } });
  assert.deepStrictEqual(defaults, { SB_MAX_WIDTH: "1280", SB_FOCUS: "0" });

  // Failures reported by the script map to clear statuses.
  await failsWith(captureRobloxWindow({ platform: "win32", run: answer({ error: "not_found" }) }), 404, /No Roblox window/);
  await failsWith(captureRobloxWindow({ platform: "win32", run: answer({ error: "minimized" }) }), 409, /minimized/);
  await failsWith(captureRobloxWindow({ platform: "win32", run: answer({ error: "empty" }) }), 409, /no visible area/);
  await failsWith(captureRobloxWindow({ platform: "win32", run: answer({ error: "failed", detail: "Out of memory" }) }), 500, /failed: Out of memory/);
  await failsWith(captureRobloxWindow({ platform: "win32", run: answer({ error: "failed" }) }), 500, /failed\./);
  await failsWith(captureRobloxWindow({ platform: "win32", run: async () => ({ stdout: "", stderr: "Execution of scripts is disabled" }) }), 500, /no usable result.*Execution of scripts/);
  await failsWith(captureRobloxWindow({ platform: "win32", run: async () => ({ stdout: "not json", stderr: "" }) }), 500, /no usable result/);
  await failsWith(captureRobloxWindow({ platform: "win32", run: async () => { throw new ScreenshotError(504, "The screenshot took too long."); } }), 504, /too long/);

  // The script itself: no request data may be spliced into it, and it must cover the cases above.
  assert.ok(!/\$\{|%s/.test(POWERSHELL_SCRIPT), "the script is a constant");
  for (const needle of ["RobloxPlayerBeta", "CopyFromScreen", "SetProcessDPIAware", "SB_MAX_WIDTH", "SB_FOCUS", "not_found", "minimized", "image/jpeg"]) {
    assert.ok(POWERSHELL_SCRIPT.includes(needle), `the script must mention ${needle}`);
  }
  assert.strictEqual((POWERSHELL_SCRIPT.match(/\{/g) || []).length, (POWERSHELL_SCRIPT.match(/\}/g) || []).length, "braces in the script are balanced");

  console.log("ALL SCREENSHOT CHECKS PASSED");
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
