"use strict";

// Looks up the newest Superbase release on GitHub, at most once every 12 hours, and remembers the answer in the
// state folder. It never blocks anything and never fails loudly: without a network, a release or a reply it simply
// reports nothing. Switch it off with "updateCheck": false in superbase.config.json or SUPERBASE_UPDATE_CHECK=0.

const fs = require("fs");
const path = require("path");

const REPO = "fiangg20/superbase";
const TTL_MS = 12 * 60 * 60 * 1000;

let last = null; // { latest, url, available, checkedAt }

// "v1.3.1" or "1.3.1-beta.1" becomes [1, 3, 1, pre]. Returns null for anything else.
function parseVersion(text) {
  const match = String(text || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ""];
}

// True when `candidate` is a newer release than `installed`. A pre-release is older than its release.
function isNewer(candidate, installed) {
  const a = parseVersion(candidate);
  const b = parseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  if (a[3] === b[3]) return false;
  if (a[3] === "") return true;
  if (b[3] === "") return false;
  return a[3] > b[3];
}

function readCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && typeof data.latest === "string" && typeof data.checkedAt === "number") return data;
  } catch {
    // No cache, or it is damaged.
  }
  return null;
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    // The cache is only an optimisation.
  }
}

// Resolves { latest, url, available, checkedAt }, or null when nothing is known.
// fetchFn, now and ttlMs can be replaced, which the tests do.
async function check({ current, cacheFile, fetchFn = globalThis.fetch, now = Date.now, ttlMs = TTL_MS, repo = REPO, timeoutMs = 4000 }) {
  const cached = cacheFile ? readCache(cacheFile) : null;
  let found = cached;

  if (!cached || now() - cached.checkedAt >= ttlMs) {
    try {
      const response = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "superbase-update-check" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const release = await response.json();
        if (release && typeof release.tag_name === "string" && parseVersion(release.tag_name)) {
          found = {
            latest: release.tag_name.replace(/^v/, ""),
            url: typeof release.html_url === "string" ? release.html_url : `https://github.com/${repo}/releases`,
            checkedAt: now(),
          };
          if (cacheFile) writeCache(cacheFile, found);
        }
      } else if (response.status === 404 && cacheFile) {
        // No release has been published yet. Remember that, so the next start does not ask again right away.
        found = null;
      }
    } catch {
      // Offline, blocked or slow: keep whatever the cache said.
    }
  }

  if (!found) {
    last = null;
    return null;
  }
  last = { latest: found.latest, url: found.url, available: isNewer(found.latest, current), checkedAt: found.checkedAt };
  return last;
}

// What the last check found, for the status endpoint.
function currentResult() {
  return last;
}

module.exports = { check, current: currentResult, parseVersion, isNewer, REPO, TTL_MS };
