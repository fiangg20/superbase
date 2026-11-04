"use strict";

// Downloads one recipe (a .lua file) from a short list of trusted code hosts. It only fetches text: nothing is saved or
// run here, and the caller decides what to do with it. Everything that touches the network goes through `fetchFn`, so
// the tests use a fake.

const MAX_BYTES = 100 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15000;
const HOSTS = new Set(["raw.githubusercontent.com", "gist.githubusercontent.com", "github.com", "gist.github.com", "gitlab.com"]);

class ImportError extends Error {}

function parse(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new ImportError("That is not a valid address. Use a full https link to a .lua file.");
  }
  if (url.protocol !== "https:") throw new ImportError("Only https links are allowed.");
  if (url.username || url.password) throw new ImportError("Links with a user name or password are not allowed.");
  if (url.port) throw new ImportError("Links with a port number are not allowed.");
  if (!HOSTS.has(url.hostname)) {
    throw new ImportError(`${url.hostname} is not on the list of allowed hosts (${[...HOSTS].join(", ")}).`);
  }
  return url;
}

// Turns a page link into the link of the raw file.
function toRawUrl(input) {
  const url = parse(input);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.hostname === "github.com") {
    // /owner/repo/blob/ref/path... or /owner/repo/raw/ref/path...
    if (parts.length >= 5 && (parts[2] === "blob" || parts[2] === "raw")) {
      return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join("/")}`;
    }
    throw new ImportError("Use the link of a single file on GitHub (a .../blob/... link), not of a repository or a folder.");
  }
  if (url.hostname === "gist.github.com") {
    // /user/id
    if (parts.length >= 2) return `https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`;
    throw new ImportError("Use the link of a gist, for example https://gist.github.com/user/id.");
  }
  if (url.hostname === "gitlab.com") {
    const marker = parts.indexOf("-");
    if (marker >= 2 && parts[marker + 1] === "blob") {
      return `https://gitlab.com/${parts.slice(0, marker).join("/")}/-/raw/${parts.slice(marker + 2).join("/")}`;
    }
    if (marker >= 2 && parts[marker + 1] === "raw") return `https://gitlab.com${url.pathname}`;
    throw new ImportError("Use the link of a single file on GitLab (a .../-/blob/... link).");
  }
  if (parts.length < 3 && url.hostname === "raw.githubusercontent.com") {
    throw new ImportError("Use the link of a single file.");
  }
  return `${url.origin}${url.pathname}`;
}

// Reads the body, giving up when it is bigger than MAX_BYTES.
async function readLimited(response) {
  const declared = Number(response.headers && response.headers.get && response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new ImportError(`The file is larger than ${MAX_BYTES / 1024} KB.`);

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ImportError(`The file is larger than ${MAX_BYTES / 1024} KB.`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new ImportError(`The file is larger than ${MAX_BYTES / 1024} KB.`);
  return buffer;
}

// A name for the recipe, taken from the file name of the link.
function suggestName(rawUrl) {
  const last = new URL(rawUrl).pathname.split("/").filter(Boolean).pop() || "";
  const base = last.replace(/\.(lua|luau|txt)$/i, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 60);
  // A gist link ends in "raw", which says nothing.
  return base && base !== "raw" ? base : "imported-recipe";
}

async function fetchRecipe(input, { fetchFn = globalThis.fetch } = {}) {
  if (typeof fetchFn !== "function") throw new ImportError("This version of Node has no fetch.");
  let target = toRawUrl(input);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response;
    try {
      response = await fetchFn(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "text/plain, */*", "user-agent": "superbase-recipe-import" },
      });
    } catch (error) {
      throw new ImportError(`Could not download the file: ${error.message}`);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new ImportError("The host redirected without saying where.");
      // A redirect is followed only to another allowed host over https.
      target = parse(new URL(location, target).toString()).toString();
      continue;
    }
    if (response.status === 404) throw new ImportError("The host says there is no file at that link (404).");
    if (!response.ok) throw new ImportError(`The host answered with status ${response.status}.`);

    const buffer = await readLimited(response);
    if (buffer.includes(0)) throw new ImportError("The file is not text.");
    const source = buffer.toString("utf8");
    if (source.trim() === "") throw new ImportError("The file is empty.");
    if (/^\s*<(!doctype|html)/i.test(source)) throw new ImportError("The link leads to a web page, not to a .lua file. Use the link of the raw file or of the file page.");
    return { url: target, source, bytes: buffer.length, suggestedName: suggestName(target) };
  }
  throw new ImportError("Too many redirects.");
}

module.exports = { fetchRecipe, toRawUrl, suggestName, ImportError, HOSTS, MAX_BYTES };
