#!/usr/bin/env node
"use strict";
/**
 * Dynamic Claude model discovery.
 *
 * Source of truth is the Claude Code CLI itself, so newly released models and
 * versions appear without editing any list by hand:
 *   1. mine candidate model ids out of the installed CLI bundle
 *   2. probe every candidate through `claude --print` and keep the ones the
 *      account can actually call (invalid ids come back as a 404/model_not_found
 *      with zero tokens billed)
 *   3. resolve family aliases (opus/sonnet/haiku/...) to the concrete id they
 *      currently point at, so an alias always tracks the newest release
 *
 * Results are cached; a full re-probe only happens when the CLI version changes.
 *
 * Usage: node claude-models-discover.js [--force] [--quiet]
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CACHE_PATH =
  process.env.CLAUDE_MODELS_CACHE || path.join(HOME, ".openclaw", "claude-models.json");
const TTL_MS = Number(process.env.CLAUDE_MODELS_TTL_MS || 12 * 60 * 60 * 1000);
const CONCURRENCY = Math.max(1, Number(process.env.CLAUDE_PROBE_CONCURRENCY || 4));
const PROBE_TIMEOUT_MS = Number(process.env.CLAUDE_PROBE_TIMEOUT_MS || 120000);
const MISS_LIMIT = Math.max(1, Number(process.env.CLAUDE_MISS_LIMIT || 2));
const BASE_ALIASES = ["opus", "sonnet", "haiku"];
const CONTEXT_WINDOW = Number(process.env.CLAUDE_CONTEXT_WINDOW || 200000);
const MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS || 16384);
const MAX_CANDIDATES = Number(process.env.CLAUDE_MAX_CANDIDATES || 200);

function log(...a) {
  if (!process.env.CLAUDE_DISCOVER_QUIET) console.error("[discover]", ...a);
}

function cliVersion() {
  try {
    return execFileSync(CLAUDE_BIN, ["--version"], { encoding: "utf8", timeout: 30000 })
      .trim()
      .split(/\s+/)[0];
  } catch (_) {
    return "unknown";
  }
}

/** Locate the installed @anthropic-ai/claude-code package directory. */
function claudePackageDir() {
  let start;
  try {
    start = execFileSync("/usr/bin/which", [CLAUDE_BIN], { encoding: "utf8" }).trim();
    start = fs.realpathSync(start);
  } catch (_) {
    return null;
  }
  let dir = path.dirname(start);
  for (let i = 0; i < 8 && dir !== "/"; i += 1) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (parsed.name === "@anthropic-ai/claude-code") return dir;
      } catch (_) { /* keep walking */ }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function cleanCandidate(raw) {
  let id = String(raw || "").trim().toLowerCase().replace(/[-.,;:)"'\]]+$/, "");
  if (!/^claude-[a-z]{3,10}-[0-9][0-9a-z.-]*$/.test(id)) return null;
  if (id.startsWith("claude-code-")) return null;
  if (id.endsWith("-v1") || id.includes("internal") || id.includes("latest")) return null;
  // Reject "claude-fable-5-mythos-5" style concatenations picked up from the
  // binary: at most one family segment, plus an optional known variant suffix.
  const VARIANTS = new Set(["fast", "thinking"]);
  const words = id.split("-").filter((s) => /^[a-z]{2,10}$/.test(s)).slice(1);
  if (words.length > 2) return null;
  if (words.length === 2 && !VARIANTS.has(words[1])) return null;
  return id;
}

/** Model ids embedded in the installed CLI bundle. Grows on `claude update`. */
function mineCandidates() {
  const dir = claudePackageDir();
  const out = new Set();
  if (!dir) {
    log("claude package dir not found; falling back to aliases only");
    return out;
  }
  let raw = "";
  try {
    raw = execFileSync(
      "/usr/bin/grep",
      ["-rhoaE", "claude-[a-z]{3,10}-[0-9][0-9a-zA-Z.-]*", dir],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 180000 }
    );
  } catch (err) {
    // grep exits 1 when nothing matched; anything else is worth surfacing.
    if (err && err.status !== 1) log("candidate mining failed:", err.message);
    return out;
  }
  for (const line of raw.split("\n")) {
    const id = cleanCandidate(line);
    if (id) out.add(id);
  }
  return out;
}

function familyOf(id) {
  const parts = String(id).split("-");
  return parts.length > 1 ? parts[1] : id;
}

/** Numeric version segments of an id: claude-opus-4-8 -> [4, 8]. */
function parseVersion(id) {
  const nums = [];
  for (const part of String(id).split("-").slice(2)) {
    if (/^\d+$/.test(part)) nums.push(Number(part));
    else if (/^\d+\.\d+$/.test(part)) nums.push(...part.split(".").map(Number));
    else break; // variant suffix such as "fast"
  }
  return nums;
}

function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * Ids one or two releases ahead of what is already known, per family.
 *
 * The installed CLI bundle only contains models that existed when it was built,
 * so mining alone cannot see a model released since — claude-opus-5 shipped
 * without a CLI update and was invisible until this existed. Probing forward is
 * cheap: an id that is not real answers 404 with nothing billed.
 */
function speculativeCandidates(known) {
  const newestByFamily = new Map();
  for (const id of known) {
    const version = parseVersion(id);
    if (!version.length) continue;
    const family = familyOf(id);
    const current = newestByFamily.get(family);
    if (!current || compareVersions(version, current) > 0) newestByFamily.set(family, version);
  }
  const out = new Set();
  for (const [family, version] of newestByFamily) {
    const major = version[0] || 0;
    const minor = version.length > 1 ? version[1] : 0;
    for (let i = 1; i <= 3; i += 1) out.add(`claude-${family}-${major}-${minor + i}`);
    for (let bump = 1; bump <= 2; bump += 1) {
      out.add(`claude-${family}-${major + bump}`);
      for (let i = 0; i <= 2; i += 1) out.add(`claude-${family}-${major + bump}-${i}`);
    }
  }
  return out;
}

/** Optional manual additions, one id per line. */
function extraCandidates() {
  const file = path.join(HOME, ".openclaw", "claude-models-extra.txt");
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => cleanCandidate(line.split("#")[0]))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Run one model through the CLI and decide whether the account can call it.
 * Resolves { ok, resolvedId }. Killed as soon as the verdict is known, so a
 * valid model costs a handful of output tokens at most.
 */
function probe(model) {
  return new Promise((resolve) => {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--model", model,
      "hi",
    ];
    let child;
    let settled = false;
    let buffer = "";
    let resolvedId = null;
    let timer = null;
    // A definite "this id does not exist" from the API, as opposed to a probe
    // that simply did not reach a verdict (timeout, spawn failure, load).
    let notFound = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (child) child.kill("SIGKILL"); } catch (_) { /* already gone */ }
      resolve({ model, ok, resolvedId: resolvedId || model, notFound });
    };

    function consume(ev) {
      if (!ev || settled) return;
      if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string") {
        resolvedId = ev.model;
        return;
      }
      if (ev.error === "model_not_found") { notFound = true; finish(false); return; }
      if (ev.type === "stream_event" && ev.event && ev.event.type === "message_start") {
        const m = ev.event.message || {};
        if (typeof m.model === "string" && m.model !== "<synthetic>") resolvedId = m.model;
        finish(true);
        return;
      }
      if (ev.type === "assistant") {
        const m = ev.message || {};
        if (m.model === "<synthetic>") { finish(false); return; }
        if (typeof m.model === "string") resolvedId = m.model;
        finish(true);
        return;
      }
      if (ev.type === "result") {
        if (ev.api_error_status === 404) notFound = true;
        finish(!ev.is_error && !ev.api_error_status);
      }
    }

    try {
      child = spawn(CLAUDE_BIN, args, { stdio: ["ignore", "pipe", "ignore"], cwd: HOME });
    } catch (_) {
      return finish(false);
    }
    timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    child.on("error", () => finish(false));
    child.on("close", () => {
      // The decisive event is the LAST line and may arrive without a trailing
      // newline, leaving it stuck in the buffer. Flush before giving a verdict,
      // otherwise a perfectly valid model is randomly reported as invalid.
      const tail = buffer.trim();
      buffer = "";
      if (tail) {
        try { consume(JSON.parse(tail)); } catch (_) { /* not JSON */ }
      }
      finish(false);
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (_) { continue; }
        consume(ev);
        if (settled) return;
      }
    });
  });
}

async function pool(items, size, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function readCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    if (parsed && Array.isArray(parsed.models)) return parsed;
  } catch (_) { /* treat any unreadable cache as absent */ }
  return null;
}

function writeCache(payload) {
  const tmp = `${CACHE_PATH}.tmp`;
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, CACHE_PATH); // atomic: readers never see a partial file
  return payload;
}

function isFresh(cache) {
  if (!cache || !cache.generatedAt) return false;
  const age = Date.now() - Date.parse(cache.generatedAt);
  return Number.isFinite(age) && age >= 0 && age < TTL_MS;
}

/**
 * Catalog entries use Anthropic's own model ids verbatim — no invented names
 * and no alias pseudo-models. Alias resolution is kept as metadata instead.
 * Sorted by family, newest version first.
 */
function toCatalog(concrete) {
  return [...new Set(concrete)]
    .sort(
      (a, b) =>
        familyOf(a).localeCompare(familyOf(b)) ||
        compareVersions(parseVersion(b), parseVersion(a)) ||
        a.localeCompare(b)
    )
    .map((id) => ({
      id,
      name: id,
      family: familyOf(id),
      version: parseVersion(id),
      contextWindow: CONTEXT_WINDOW,
      maxTokens: MAX_TOKENS,
    }));
}

/**
 * Returns the model catalog, re-probing only when it is stale or the CLI moved.
 * A same-version refresh re-probes aliases (they can be repointed server side)
 * plus any candidate the previous run had never seen.
 */
async function discover(opts) {
  const options = opts || {};
  const cache = readCache();
  const version = cliVersion();

  if (!options.force && cache && cache.cliVersion === version && isFresh(cache)) {
    return cache;
  }

  const mined = mineCandidates();
  const cachedIds = (cache && cache.models ? cache.models : [])
    .map((m) => m.id)
    .filter((id) => typeof id === "string" && id.startsWith("claude-"));
  const families = new Set(BASE_ALIASES);
  for (const id of mined) families.add(familyOf(id));
  for (const id of cachedIds) families.add(familyOf(id));
  const aliasList = [...families].sort();

  // --force means re-probe everything, not just skip the freshness check.
  const sameVersion = Boolean(cache && cache.cliVersion === version) && !options.force;
  const knownGood = sameVersion ? cachedIds : [];

  // Speculative ids are probed on EVERY refresh: a new model can appear server
  // side with no CLI update at all, which is how claude-opus-5 shipped.
  const speculative = speculativeCandidates([...mined, ...cachedIds]);
  const extras = extraCandidates();

  const pool0 = new Set([...speculative, ...extras]);
  for (const id of mined) if (!sameVersion || !knownGood.includes(id)) pool0.add(id);
  const concreteToProbe = [...pool0].slice(0, MAX_CANDIDATES);
  if (pool0.size > concreteToProbe.length) {
    log(`WARNING: candidate cap dropped ${pool0.size - concreteToProbe.length} id(s); raise CLAUDE_MAX_CANDIDATES`);
  }

  const targets = [...aliasList, ...concreteToProbe];
  log(
    `cli=${version} ${sameVersion ? "incremental" : "full"} probe:`,
    `${aliasList.length} alias(es) + ${concreteToProbe.length} candidate(s)`,
    `(${speculative.size} speculative)`
  );

  // Retry only inconclusive probes — a spawn that times out or dies under load
  // must not be read as "this model does not exist". A definite 404 is final,
  // so the many speculative misses cost exactly one attempt each.
  const probeWithRetry = async (id) => {
    const first = await probe(id);
    if (first.ok || first.notFound) return first;
    await new Promise((r) => setTimeout(r, 1500));
    return probe(id);
  };

  const probed = await pool(targets, CONCURRENCY, probeWithRetry);
  const aliases = {};
  const concrete = new Set(knownGood);
  const superseded = {};

  for (const result of probed) {
    if (!result || !result.ok) continue;
    const resolved = result.resolvedId || result.model;
    if (families.has(result.model)) {
      aliases[result.model] = resolved;
      concrete.add(resolved);
      continue;
    }
    // The CLI silently upgrades retired ids to the current release, so an id
    // that does not resolve to itself would be a lie in the catalog: advertise
    // what actually answers instead.
    if (resolved === result.model) concrete.add(result.model);
    else {
      superseded[result.model] = resolved;
      concrete.add(resolved);
    }
  }

  if (Object.keys(aliases).length === 0 && concrete.size === 0) {
    log("discovery found nothing callable; keeping previous catalog");
    if (cache) return cache;
    throw new Error("model discovery failed and no cached catalog exists");
  }

  // Sticky removal: an id that was good before only leaves the catalog after
  // MISS_LIMIT consecutive failed refreshes, so a bad night for the API cannot
  // silently shrink the model list.
  const probedIds = new Set(probed.filter(Boolean).map((r) => r.model));
  const answered = new Set(probed.filter((r) => r && r.ok).map((r) => r.resolvedId || r.model));
  const misses = { ...((cache && cache.misses) || {}) };
  for (const id of cachedIds) {
    if (answered.has(id)) { delete misses[id]; continue; }
    if (!probedIds.has(id)) continue; // never asked this round; leave it alone
    misses[id] = (misses[id] || 0) + 1;
    if (misses[id] >= MISS_LIMIT) {
      concrete.delete(id);
      delete misses[id];
      log(`dropping ${id} after ${MISS_LIMIT} consecutive misses`);
    } else {
      log(`keeping ${id} despite a failed probe (miss ${misses[id]}/${MISS_LIMIT})`);
    }
  }

  for (const id of Object.keys(superseded)) concrete.delete(id);
  const models = toCatalog([...concrete]);
  const retired = Object.keys(superseded).length;
  log(`catalog: ${models.length} model(s)${retired ? `, ${retired} retired id(s) folded in` : ""}`);
  return writeCache({
    generatedAt: new Date().toISOString(),
    cliVersion: version,
    aliases,
    superseded,
    misses,
    models,
  });
}

module.exports = { discover, readCache, isFresh, CACHE_PATH };

if (require.main === module) {
  const force = process.argv.includes("--force");
  if (process.argv.includes("--quiet")) process.env.CLAUDE_DISCOVER_QUIET = "1";
  discover({ force })
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[discover] ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
}
