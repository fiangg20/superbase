"use strict";

// The update check: version comparison, the cache, and every way the network can fail.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { check, current, parseVersion, isNewer, TTL_MS } = require("../src/update-check");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superbase-update-"));
const cacheFile = path.join(dir, "update.json");

// Versions.
assert.deepStrictEqual(parseVersion("v1.3.1"), [1, 3, 1, ""]);
assert.deepStrictEqual(parseVersion("2.0.0-beta.1"), [2, 0, 0, "beta.1"]);
assert.strictEqual(parseVersion("latest"), null);
assert.strictEqual(parseVersion("1.3"), null);
assert.ok(isNewer("1.3.2", "1.3.1"));
assert.ok(isNewer("1.4.0", "1.3.9"));
assert.ok(isNewer("v2.0.0", "1.99.99"));
assert.ok(!isNewer("1.3.1", "1.3.1"));
assert.ok(!isNewer("1.3.0", "1.3.1"));
assert.ok(isNewer("1.10.0", "1.9.0"), "numbers are compared as numbers");
assert.ok(isNewer("1.4.0", "1.4.0-beta.1"), "a release is newer than its pre-release");
assert.ok(!isNewer("1.4.0-beta.1", "1.4.0"));
assert.ok(!isNewer("garbage", "1.0.0") && !isNewer("1.0.0", "garbage"));

const release = (tag, extra = {}) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ tag_name: tag, html_url: `https://github.com/fiangg20/superbase/releases/tag/${tag}`, ...extra }),
});

(async () => {
  assert.strictEqual(current(), null, "nothing is known before the first check");

  // A newer release.
  let calls = 0;
  let clock = 1000;
  const counting = (inner) => async (...args) => {
    calls += 1;
    assert.ok(String(args[0]).startsWith("https://api.github.com/repos/fiangg20/superbase/releases/latest"));
    assert.ok(args[1].signal, "the request has a timeout");
    return inner(...args);
  };
  let result = await check({ current: "1.3.1", cacheFile, fetchFn: counting(release("v1.4.0")), now: () => clock });
  assert.deepStrictEqual({ latest: result.latest, available: result.available }, { latest: "1.4.0", available: true });
  assert.ok(result.url.includes("v1.4.0"));
  assert.deepStrictEqual(current(), result);
  assert.strictEqual(calls, 1);

  // The cache answers for 12 hours.
  clock += TTL_MS - 1;
  result = await check({ current: "1.3.1", cacheFile, fetchFn: counting(release("v9.9.9")), now: () => clock });
  assert.strictEqual(result.latest, "1.4.0");
  assert.strictEqual(calls, 1, "no request while the cache is fresh");
  clock += 2;
  result = await check({ current: "1.3.1", cacheFile, fetchFn: counting(release("v1.5.0")), now: () => clock });
  assert.strictEqual(result.latest, "1.5.0");
  assert.strictEqual(calls, 2, "a request once the cache is old");

  // The cached answer is judged against the version that is installed now.
  result = await check({ current: "1.5.0", cacheFile, fetchFn: counting(release("v9.9.9")), now: () => clock });
  assert.strictEqual(result.available, false);

  // Up to date.
  fs.rmSync(cacheFile);
  result = await check({ current: "1.3.1", cacheFile, fetchFn: release("v1.3.1") });
  assert.strictEqual(result.available, false);

  // Failures give no answer and never throw.
  fs.rmSync(cacheFile);
  assert.strictEqual(await check({ current: "1.3.1", cacheFile, fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }) }), null, "no release published yet");
  assert.strictEqual(current(), null);
  assert.strictEqual(await check({ current: "1.3.1", cacheFile, fetchFn: async () => { throw new Error("offline"); } }), null);
  assert.strictEqual(await check({ current: "1.3.1", cacheFile, fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }) }), null);
  assert.strictEqual(await check({ current: "1.3.1", cacheFile, fetchFn: release("not-a-version") }), null, "a tag that is not a version is ignored");
  assert.strictEqual(await check({ current: "1.3.1", cacheFile, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }) }), null);

  // Offline with an old cache: the old answer is kept.
  fs.writeFileSync(cacheFile, JSON.stringify({ latest: "1.4.0", url: "https://example.test", checkedAt: 1 }));
  result = await check({ current: "1.3.1", cacheFile, fetchFn: async () => { throw new Error("offline"); }, now: () => 1 + TTL_MS * 5 });
  assert.strictEqual(result.latest, "1.4.0");
  assert.strictEqual(result.available, true);

  // A damaged cache file is ignored.
  fs.writeFileSync(cacheFile, "{{{");
  result = await check({ current: "1.3.1", cacheFile, fetchFn: release("v1.3.5") });
  assert.strictEqual(result.latest, "1.3.5");

  // Without a cache file it still works.
  result = await check({ current: "1.3.1", fetchFn: release("v1.3.9") });
  assert.strictEqual(result.latest, "1.3.9");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("ALL UPDATE CHECK CHECKS PASSED");
})().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
