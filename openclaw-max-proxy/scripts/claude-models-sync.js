#!/usr/bin/env node
"use strict";
/**
 * Sync discovered Claude models into openclaw.json.
 *
 * OpenClaw only auto-discovers models for LM Studio / Ollama / OpenRouter; for
 * a custom openai-completions provider the config list is authoritative. This
 * job regenerates that list from live discovery, applies it through
 * `openclaw config patch` (schema-validated write), and reloads the gateway —
 * but only when the model set actually changed, so it is safe to run on a timer.
 *
 * Usage: node claude-models-sync.js [--force] [--dry-run]
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const discovery = require(path.join(__dirname, "claude-models-discover.js"));

const PROVIDER = process.env.OPENCLAW_PROVIDER_ID || "claude-proxy";
const BASE_URL = process.env.OPENCLAW_PROVIDER_BASE_URL || "http://127.0.0.1:3457/v1";
const GATEWAY_LABEL = process.env.OPENCLAW_GATEWAY_LABEL || "ai.openclaw.gateway";
// Model ids are Anthropic's own, so "newest opus" is resolved by version rather
// than by a fixed name. Set OPENCLAW_PIN_PRIMARY to opt out of auto-tracking.
const PRIMARY_FAMILY = process.env.OPENCLAW_PRIMARY_FAMILY || "opus";
const FALLBACK_FAMILIES = (process.env.OPENCLAW_FALLBACK_FAMILIES || "sonnet,haiku").split(",");
const PINNED_PRIMARY = (process.env.OPENCLAW_PIN_PRIMARY || "").trim();
const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");

function log(...a) {
  console.log(`[model-sync ${new Date().toISOString()}]`, ...a);
}

function openclaw(args, opts) {
  return execFileSync("openclaw", args, {
    encoding: "utf8",
    timeout: (opts && opts.timeout) || 120000,
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` },
  });
}

function configPath() {
  try {
    const out = openclaw(["config", "file"], { timeout: 60000 }).trim().split("\n").pop().trim();
    if (out && fs.existsSync(out)) return out;
  } catch (_) { /* fall through to the default location */ }
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

function sameModelList(a, b) {
  const key = (list) => JSON.stringify(
    (list || []).map((m) => [m.id, m.name, m.contextWindow, m.maxTokens])
  );
  return key(a) === key(b);
}

function main() {
  return discovery.discover({ force: FORCE }).then((catalog) => {
    const models = (catalog.models || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    if (!models.length) throw new Error("discovery returned no models; refusing to patch config");

    const file = configPath();
    const cfg = readConfig(file);
    const provider = ((cfg.models || {}).providers || {})[PROVIDER] || {};
    const defaults = (cfg.agents || {}).defaults || {};
    const currentAllow = defaults.models || {};

    const ids = new Set(models.map((m) => m.id));
    const ref = (id) => `${PROVIDER}/${id}`;

    // Allowlist: add every discovered model, delete entries that no longer exist.
    const allowPatch = {};
    for (const id of ids) if (!(ref(id) in currentAllow)) allowPatch[ref(id)] = {};
    for (const key of Object.keys(currentAllow)) {
      if (!key.startsWith(`${PROVIDER}/`)) continue;
      if (!ids.has(key.slice(PROVIDER.length + 1))) allowPatch[key] = null;
    }

    // Newest release per family, so a new model becomes the default the moment
    // discovery sees it — unless OPENCLAW_PIN_PRIMARY says otherwise.
    const byVersion = (a, b) => {
      const va = a.version || [];
      const vb = b.version || [];
      const len = Math.max(va.length, vb.length);
      for (let i = 0; i < len; i += 1) {
        const diff = (vb[i] || 0) - (va[i] || 0);
        if (diff) return diff;
      }
      return a.id.localeCompare(b.id);
    };
    const newestIn = (family) => {
      const inFamily = (catalog.models || []).filter((m) => m.family === family).sort(byVersion);
      return inFamily.length ? inFamily[0].id : null;
    };

    const currentModel = defaults.model || {};
    const currentPrimary = typeof currentModel === "string" ? currentModel : currentModel.primary;
    const pinned = PINNED_PRIMARY.replace(`${PROVIDER}/`, "");
    const primaryId = (pinned && ids.has(pinned) && pinned) || newestIn(PRIMARY_FAMILY) || models[0].id;
    const primary = ref(primaryId);
    const fallbacks = FALLBACK_FAMILIES
      .map((f) => newestIn(f.trim()))
      .filter((id) => id && id !== primaryId)
      .map(ref);

    const currentFallbacks = Array.isArray(currentModel.fallbacks) ? currentModel.fallbacks : [];
    const changed =
      !sameModelList(provider.models, models) ||
      Object.keys(allowPatch).length > 0 ||
      currentPrimary !== primary ||
      JSON.stringify(currentFallbacks) !== JSON.stringify(fallbacks);

    if (!changed) {
      log(`no change (${models.length} models, primary ${primary})`);
      return 0;
    }

    const patch = {
      models: {
        providers: {
          [PROVIDER]: {
            baseUrl: BASE_URL,
            apiKey: "not-needed",
            api: "openai-completions",
            timeoutSeconds: Number(process.env.OPENCLAW_PROVIDER_TIMEOUT || 900),
            models,
          },
        },
      },
      agents: {
        defaults: {
          model: { primary, fallbacks },
          ...(Object.keys(allowPatch).length ? { models: allowPatch } : {}),
        },
      },
    };

    const patchFile = path.join(os.tmpdir(), `openclaw-model-sync-${process.pid}.json`);
    fs.writeFileSync(patchFile, `${JSON.stringify(patch, null, 2)}\n`, { mode: 0o600 });
    // Arrays that shrink need an explicit replace path; OpenClaw refuses a
    // silent removal otherwise.
    const replacePaths = [
      "--replace-path", `models.providers.${PROVIDER}.models`,
      "--replace-path", "agents.defaults.model.fallbacks",
    ];
    try {
      if (DRY_RUN) {
        log(openclaw(["config", "patch", "--file", patchFile, ...replacePaths, "--dry-run"]).trim());
        return 0;
      }
      log(openclaw(["config", "patch", "--file", patchFile, ...replacePaths]).trim());
      log(`applied ${models.length} model(s); primary ${primary}`);
      try {
        execFileSync("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${GATEWAY_LABEL}`], {
          encoding: "utf8",
          timeout: 60000,
        });
        log("gateway reloaded");
      } catch (err) {
        log(`gateway reload failed (config is still applied): ${err.message}`);
      }
    } finally {
      try { fs.unlinkSync(patchFile); } catch (_) { /* best effort */ }
    }
    return 0;
  });
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(`[model-sync] ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
