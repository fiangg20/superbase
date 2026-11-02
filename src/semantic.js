"use strict";

// Semantic search over the scripts of a game, with embeddings from a local Ollama (default model: embeddinggemma).
// The scripts are dumped from the game (src/lua/dump_scripts.lua), cut into chunks, embedded and stored on disk.
// A search embeds the question and returns the chunks that are closest in meaning. Nothing leaves this computer.

const fs = require("fs");
const path = require("path");

const DEFAULT_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "embeddinggemma";
const BATCH = 16;
const FILE_VERSION = 1;

class SemanticError extends Error {}

// Cuts source code into pieces of at most maxChars, at blank lines or at the start of a function when possible.
// Every chunk remembers the lines it came from.
function chunkSource(source, { maxChars = 1400, minChars = 200 } = {}) {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const chunks = [];
  let start = 0;
  let size = 0;

  const flush = (end) => {
    const text = lines.slice(start, end).join("\n").trim();
    if (text.length > 0) chunks.push({ start: start + 1, end, text });
    start = end;
    size = 0;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const startsFunction = /^\s*(local\s+)?function\b/.test(line);
    // Start a new chunk before a function when the current one is big enough to stand alone.
    if (startsFunction && size >= minChars) flush(i);
    // A single huge line is cut into pieces of its own.
    if (line.length > maxChars) {
      if (size > 0) flush(i);
      for (let at = 0; at < line.length; at += maxChars) {
        chunks.push({ start: i + 1, end: i + 1, text: line.slice(at, at + maxChars) });
      }
      start = i + 1;
      size = 0;
      continue;
    }
    if (size + line.length + 1 > maxChars && size > 0) {
      // Prefer to break at the last blank line of this chunk when there is one in its second half.
      let cut = i;
      for (let j = i - 1; j > start + (i - start) / 2; j -= 1) {
        if (lines[j].trim() === "") {
          cut = j + 1;
          break;
        }
      }
      flush(cut);
      // Lines between the cut and i belong to the next chunk, so recount them.
      size = lines.slice(start, i).reduce((sum, item) => sum + item.length + 1, 0);
    }
    size += line.length + 1;
  }
  flush(lines.length);
  return chunks;
}

function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, (value) => value / length);
}

// embeddinggemma was trained with these prefixes. Other models get the plain text.
function formatInput(model, kind, text, title) {
  if (/^embeddinggemma/i.test(model)) {
    return kind === "query" ? `task: code retrieval | query: ${text}` : `title: ${title || "none"} | text: ${text}`;
  }
  return text;
}

// Asks Ollama for embeddings. `inputs` are plain strings. Returns normalized Float32Arrays in the same order.
async function embed(inputs, { url = DEFAULT_URL, model = DEFAULT_MODEL, fetchFn = globalThis.fetch, timeoutMs = 120000 } = {}) {
  const out = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    let response;
    try {
      response = await fetchFn(`${url.replace(/\/+$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SemanticError(
        `Ollama is not reachable at ${url} (${error.cause && error.cause.code ? error.cause.code : error.message}). Install it from https://ollama.com, start it, and run: ollama pull ${model}`,
      );
    }
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON, reported below.
    }
    if (!response.ok) {
      const detail = data && data.error ? data.error : text.slice(0, 200);
      if (response.status === 404 || /not found/i.test(detail)) {
        throw new SemanticError(`Ollama does not have the model ${model}. Run: ollama pull ${model}`);
      }
      throw new SemanticError(`Ollama answered ${response.status}: ${detail}`);
    }
    if (!data || !Array.isArray(data.embeddings) || data.embeddings.length !== batch.length) {
      throw new SemanticError("Ollama returned an unexpected answer for /api/embed. Is the Ollama version recent enough (0.3.0 or later)?");
    }
    for (const vector of data.embeddings) out.push(normalize(vector));
  }
  return out;
}

// --- The index on disk: <dir>/<placeId>.json (chunks) and <dir>/<placeId>.vec (float32 vectors) ---------------------

const safeId = (placeId) => String(placeId).replace(/[^0-9A-Za-z_-]/g, "_");

class IndexStore {
  constructor(dir) {
    this.dir = dir;
  }

  files(placeId) {
    const id = safeId(placeId);
    return { meta: path.join(this.dir, `${id}.json`), vec: path.join(this.dir, `${id}.vec`) };
  }

  // Returns { meta, vectors: Float32Array[] } or null.
  load(placeId) {
    const { meta, vec } = this.files(placeId);
    try {
      const info = JSON.parse(fs.readFileSync(meta, "utf8"));
      if (info.version !== FILE_VERSION) return null;
      const buffer = fs.readFileSync(vec);
      const all = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
      if (all.length !== info.chunks.length * info.dim) return null;
      const vectors = info.chunks.map((_, index) => all.slice(index * info.dim, (index + 1) * info.dim));
      return { meta: info, vectors };
    } catch {
      return null;
    }
  }

  save(placeId, meta, vectors) {
    fs.mkdirSync(this.dir, { recursive: true });
    const { meta: metaFile, vec } = this.files(placeId);
    const dim = vectors.length > 0 ? vectors[0].length : meta.dim || 0;
    const all = new Float32Array(vectors.length * dim);
    vectors.forEach((vector, index) => all.set(vector, index * dim));
    fs.writeFileSync(vec, Buffer.from(all.buffer));
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, version: FILE_VERSION, dim, count: vectors.length }));
  }

  remove(placeId) {
    let removed = false;
    for (const file of Object.values(this.files(placeId))) {
      try {
        fs.unlinkSync(file);
        removed = true;
      } catch {
        // Not there.
      }
    }
    return removed;
  }

  // Place ids that have an index, the newest first.
  list() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => ({ placeId: name.slice(0, -5), at: fs.statSync(path.join(this.dir, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .map((item) => item.placeId);
    } catch {
      return [];
    }
  }
}

// Cosine similarity of normalized vectors is their dot product.
function topMatches(vectors, query, k, accept = () => true) {
  const scored = [];
  for (let i = 0; i < vectors.length; i += 1) {
    if (!accept(i)) continue;
    let dot = 0;
    const vector = vectors[i];
    for (let j = 0; j < query.length; j += 1) dot += vector[j] * query[j];
    scored.push({ index: i, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

module.exports = { chunkSource, embed, formatInput, normalize, IndexStore, topMatches, SemanticError, DEFAULT_URL, DEFAULT_MODEL };
