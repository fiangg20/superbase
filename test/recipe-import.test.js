"use strict";

// Recipe import: link handling, the host allowlist, redirects, limits and the checks on what comes back.

const assert = require("assert");
const { fetchRecipe, toRawUrl, suggestName, ImportError, MAX_BYTES } = require("../src/recipe-import");

async function main() {
  // Page links become raw links.
  assert.strictEqual(toRawUrl("https://github.com/fiangg20/recipes/blob/main/tools/list-remotes.lua"), "https://raw.githubusercontent.com/fiangg20/recipes/main/tools/list-remotes.lua");
  assert.strictEqual(toRawUrl("https://github.com/o/r/raw/dev/a.lua"), "https://raw.githubusercontent.com/o/r/dev/a.lua");
  assert.strictEqual(toRawUrl("https://gist.github.com/someone/abc123"), "https://gist.githubusercontent.com/someone/abc123/raw");
  assert.strictEqual(toRawUrl("https://gist.githubusercontent.com/someone/abc123/raw/file.lua"), "https://gist.githubusercontent.com/someone/abc123/raw/file.lua");
  assert.strictEqual(toRawUrl("https://raw.githubusercontent.com/o/r/main/a.lua"), "https://raw.githubusercontent.com/o/r/main/a.lua");
  assert.strictEqual(toRawUrl("https://gitlab.com/group/sub/project/-/blob/main/x/y.lua"), "https://gitlab.com/group/sub/project/-/raw/main/x/y.lua");
  assert.strictEqual(toRawUrl("https://gitlab.com/group/project/-/raw/main/y.lua"), "https://gitlab.com/group/project/-/raw/main/y.lua");

  // Things that are refused before any request is made.
  const refused = [
    ["http://raw.githubusercontent.com/o/r/main/a.lua", /https/],
    ["ftp://github.com/o/r/blob/main/a.lua", /https/],
    ["https://user:pw@raw.githubusercontent.com/o/r/main/a.lua", /user name/],
    ["https://raw.githubusercontent.com:8443/o/r/main/a.lua", /port/],
    ["https://evil.example.com/a.lua", /not on the list/],
    ["https://raw.githubusercontent.com.evil.example/o/r/main/a.lua", /not on the list/],
    ["https://github.com.evil.example/o/r/blob/main/a.lua", /not on the list/],
    ["https://localhost/a.lua", /not on the list/],
    ["https://127.0.0.1/a.lua", /not on the list/],
    ["https://github.com/o/r", /single file/],
    ["https://github.com/o/r/tree/main/folder", /single file/],
    ["https://gist.github.com/someone", /gist/],
    ["https://gitlab.com/group/project", /single file/],
    ["not a link", /valid address/],
    ["", /valid address/],
  ];
  for (const [link, pattern] of refused) {
    assert.throws(() => toRawUrl(link), (error) => error instanceof ImportError && pattern.test(error.message), `${link} is refused (${pattern})`);
  }

  // Names.
  assert.strictEqual(suggestName("https://raw.githubusercontent.com/o/r/main/List_Remotes.lua"), "list_remotes");
  assert.strictEqual(suggestName("https://raw.githubusercontent.com/o/r/main/My%20Script!!.lua"), "my-20script");
  assert.strictEqual(suggestName("https://gist.githubusercontent.com/u/id/raw"), "imported-recipe", "a gist link has no useful name");
  assert.strictEqual(suggestName("https://raw.githubusercontent.com/o/r/main/" + "a".repeat(100) + ".lua").length, 60);

  // A fake network.
  const calls = [];
  const network = (routes) => async (url, options) => {
    calls.push({ url, options });
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (!route) return new Response("not found", { status: 404 });
    return typeof route === "function" ? route() : route;
  };
  const LUA = "-- Recipe: Hello\n-- Description: Says hello.\nreturn 'hello'\n";
  const RAW = "https://raw.githubusercontent.com/o/r/main/hello.lua";

  let result = await fetchRecipe("https://github.com/o/r/blob/main/hello.lua", { fetchFn: network({ [RAW]: new Response(LUA, { status: 200 }) }) });
  assert.deepStrictEqual([result.url, result.source, result.bytes, result.suggestedName], [RAW, LUA, Buffer.byteLength(LUA), "hello"]);
  assert.strictEqual(calls[0].url, RAW, "the raw address is what gets fetched");
  assert.strictEqual(calls[0].options.redirect, "manual", "redirects are never followed blindly");
  assert.ok(calls[0].options.signal, "there is a timeout");
  assert.ok(!("cookie" in calls[0].options.headers) && !("authorization" in calls[0].options.headers), "no credentials are sent");

  // Errors from the host.
  await assert.rejects(fetchRecipe(RAW, { fetchFn: network({}) }), /no file at that link \(404\)/);
  await assert.rejects(fetchRecipe(RAW, { fetchFn: network({ [RAW]: new Response("x", { status: 500 }) }) }), /status 500/);
  await assert.rejects(fetchRecipe(RAW, { fetchFn: network({ [RAW]: new Error("getaddrinfo ENOTFOUND") }) }), /Could not download the file: getaddrinfo ENOTFOUND/);

  // What comes back must be a small Lua text.
  await assert.rejects(fetchRecipe(RAW, { fetchFn: network({ [RAW]: new Response("<!DOCTYPE html><html></html>", { status: 200 }) }) }), /web page/);
  await assert.rejects(fetchRecipe(RAW, { fetchFn: network({ [RAW]: new Response("  <html lang=en>", { status: 200 }) }) }), /web page/);
  await assert.rejects(fetchRecipe(RAW, { fetchFn: network({ [RAW]: new Response(Buffer.from([108, 117, 97, 0, 1, 2]), { status: 200 }) }) }), /not text/);
  await assert.rejects(fetchRecipe(RAW, { fetchFn: network({ [RAW]: new Response("  \n", { status: 200 }) }) }), /empty/);
  const big = "x".repeat(MAX_BYTES + 1);
  await assert.rejects(fetchRecipe(RAW, { fetchFn: network({ [RAW]: new Response(big, { status: 200 }) }) }), /larger than 100 KB/);
  await assert.rejects(fetchRecipe(RAW, { fetchFn: network({ [RAW]: new Response("x", { status: 200, headers: { "content-length": String(MAX_BYTES + 1) } }) }) }), /larger than 100 KB/, "the declared size is checked first");
  result = await fetchRecipe(RAW, { fetchFn: network({ [RAW]: new Response("x".repeat(MAX_BYTES), { status: 200 }) }) });
  assert.strictEqual(result.bytes, MAX_BYTES, "exactly the limit is fine");

  // The body is read in pieces, so an endless download is cut off.
  let pulled = 0;
  const endless = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(40 * 1024)); } });
  await assert.rejects(fetchRecipe(RAW, { fetchFn: network({ [RAW]: new Response(endless, { status: 200 }) }) }), /larger than 100 KB/);
  assert.ok(pulled <= 6, `the download stopped early (${pulled} chunks)`);

  // Redirects stay on allowed hosts and are limited.
  const GITLAB_RAW = "https://gitlab.com/g/p/-/raw/main/a.lua";
  const moved = new Response(null, { status: 302, headers: { location: "https://gitlab.com/g/p/-/raw/main/b.lua" } });
  result = await fetchRecipe(GITLAB_RAW, { fetchFn: network({ [GITLAB_RAW]: moved, "https://gitlab.com/g/p/-/raw/main/b.lua": new Response(LUA, { status: 200 }) }) });
  assert.strictEqual(result.url, "https://gitlab.com/g/p/-/raw/main/b.lua", "an allowed redirect is followed");
  assert.strictEqual(result.suggestedName, "b");
  const relative = new Response(null, { status: 301, headers: { location: "/g/p/-/raw/main/c.lua" } });
  result = await fetchRecipe(GITLAB_RAW, { fetchFn: network({ [GITLAB_RAW]: relative, "https://gitlab.com/g/p/-/raw/main/c.lua": new Response(LUA, { status: 200 }) }) });
  assert.strictEqual(result.url, "https://gitlab.com/g/p/-/raw/main/c.lua", "a relative redirect works");
  const away = () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal.lua" } });
  await assert.rejects(fetchRecipe(GITLAB_RAW, { fetchFn: network({ [GITLAB_RAW]: away }) }), /not on the list/);
  const insecure = () => new Response(null, { status: 302, headers: { location: "http://gitlab.com/g/p/-/raw/main/a.lua" } });
  await assert.rejects(fetchRecipe(GITLAB_RAW, { fetchFn: network({ [GITLAB_RAW]: insecure }) }), /https/);
  const loop = () => new Response(null, { status: 302, headers: { location: GITLAB_RAW } });
  await assert.rejects(fetchRecipe(GITLAB_RAW, { fetchFn: network({ [GITLAB_RAW]: loop }) }), /Too many redirects/);
  const nowhere = () => new Response(null, { status: 302 });
  await assert.rejects(fetchRecipe(GITLAB_RAW, { fetchFn: network({ [GITLAB_RAW]: nowhere }) }), /without saying where/);

  // The link is checked before any request goes out.
  calls.length = 0;
  await assert.rejects(fetchRecipe("https://evil.example.com/a.lua", { fetchFn: network({}) }), ImportError);
  assert.strictEqual(calls.length, 0, "no request for a refused link");

  console.log("ALL RECIPE IMPORT CHECKS PASSED");
}

main().catch((error) => {
  console.error("TEST FAILED:", error.stack || error.message);
  process.exit(1);
});
