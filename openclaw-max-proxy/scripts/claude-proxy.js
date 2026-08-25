#!/usr/bin/env node
"use strict";
/**
 * OpenAI-compatible proxy over the Claude Code CLI, for OpenClaw.
 *
 * Replaces claude-max-api-proxy + the content-flattening bridge with one
 * process, because that proxy hardcoded three model ids and silently coerced
 * every unrecognised model to opus. Here the requested model id is passed to
 * `claude --model` verbatim, and /v1/models is served from live discovery, so
 * a newly released model or family is usable the moment the CLI knows about it.
 *
 * Endpoints: GET /health, GET /v1/models, POST /v1/chat/completions
 * Env: PORT (3457), HOST (127.0.0.1), CLAUDE_BIN, CLAUDE_PROXY_MAX_CONCURRENT,
 *      CLAUDE_PROXY_TIMEOUT_MS, CLAUDE_PROXY_CWD,
 *      CLAUDE_PROXY_ALLOWED_TOOLS / CLAUDE_PROXY_DISALLOWED_TOOLS (comma lists)
 */
const http = require("http");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const discovery = require(path.join(__dirname, "claude-models-discover.js"));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3457);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CWD = process.env.CLAUDE_PROXY_CWD || path.join(os.homedir(), ".openclaw", "workspace");
const MAX_CONCURRENT = Math.max(1, Number(process.env.CLAUDE_PROXY_MAX_CONCURRENT || 4));
const RUN_TIMEOUT_MS = Number(process.env.CLAUDE_PROXY_TIMEOUT_MS || 900000);
const ALLOWED_TOOLS = (process.env.CLAUDE_PROXY_ALLOWED_TOOLS || "").split(",").filter(Boolean);
const DISALLOWED_TOOLS = (process.env.CLAUDE_PROXY_DISALLOWED_TOOLS || "").split(",").filter(Boolean);

function log(...a) {
  console.log(`[proxy ${new Date().toISOString()}]`, ...a);
}

// ---------------------------------------------------------------- catalog --

let catalog = discovery.readCache();
let refreshing = false;

/** Serve the cached catalog immediately; refresh in the background when stale. */
function ensureCatalog() {
  if (catalog && discovery.isFresh(catalog)) return catalog;
  if (!refreshing) {
    refreshing = true;
    discovery
      .discover({})
      .then((next) => {
        catalog = next;
        log(`catalog refreshed: ${next.models.length} model(s), cli ${next.cliVersion}`);
      })
      .catch((err) => log(`catalog refresh failed: ${err.message}`))
      .finally(() => { refreshing = false; });
  }
  return catalog;
}

function modelList() {
  const current = ensureCatalog();
  return current && Array.isArray(current.models) ? current.models : [];
}

// ------------------------------------------------------------------- auth --

// /health used to report "ok" purely because the HTTP listener was up. It stayed
// green through a ten-day outage after the CLI's OAuth session expired, which is
// worse than no health check at all. Ask the CLI whether it is actually logged
// in, cached so /health stays cheap.
let authState = { checkedAt: 0, loggedIn: null, detail: "not checked yet" };
const AUTH_TTL_MS = Number(process.env.CLAUDE_PROXY_AUTH_TTL_MS || 60000);
let authInFlight = false;

function refreshAuth() {
  if (authInFlight) return;
  authInFlight = true;
  execFile(CLAUDE_BIN, ["auth", "status"], { timeout: 20000 }, (err, stdout) => {
    authInFlight = false;
    authState.checkedAt = Date.now();
    if (err && !stdout) {
      authState.loggedIn = false;
      authState.detail = `could not run \`${CLAUDE_BIN} auth status\`: ${err.message}`;
      return;
    }
    try {
      const parsed = JSON.parse(String(stdout).trim());
      authState.loggedIn = parsed.loggedIn === true;
      authState.detail = authState.loggedIn
        ? `logged in via ${parsed.authMethod || "unknown"}${parsed.subscriptionType ? ` (${parsed.subscriptionType})` : ""}`
        : "CLI is logged out — run: claude auth login";
    } catch (_) {
      authState.loggedIn = null;
      authState.detail = "could not parse auth status output";
    }
  });
}

function authSnapshot() {
  if (Date.now() - authState.checkedAt > AUTH_TTL_MS) refreshAuth();
  return authState;
}

// ---------------------------------------------------------------- messages --

function flattenContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return String(content);
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Split an OpenAI messages array into the CLI's two inputs: a system prompt
 * (appended to Claude Code's own) and a single prompt carrying the transcript.
 * `claude --print` has no native multi-turn message array, so prior turns are
 * tagged and the latest user message is left plain at the end.
 */
function buildInput(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const system = [];
  const turns = [];
  for (const msg of list) {
    const text = flattenContent(msg && msg.content).trim();
    if (!text) continue;
    const role = msg.role === "assistant" || msg.role === "system" ? msg.role : "user";
    if (role === "system") system.push(text);
    else turns.push({ role, text });
  }

  let trailing = "";
  while (turns.length && turns[turns.length - 1].role === "user") {
    trailing = turns.pop().text + (trailing ? `\n\n${trailing}` : "");
  }

  const parts = [];
  if (turns.length) {
    parts.push("<conversation>");
    for (const turn of turns) {
      parts.push(`<turn role="${turn.role}">\n${escapeXml(turn.text)}\n</turn>`);
    }
    parts.push("</conversation>");
  }
  if (trailing) parts.push(trailing);

  return {
    systemPrompt: system.join("\n\n"),
    prompt: parts.join("\n\n").trim(),
  };
}

// ------------------------------------------------------------- concurrency --

let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active = Math.max(0, active - 1);
}

// -------------------------------------------------------------- CLI runner --

/**
 * Run one turn through the CLI. `onDelta` receives assistant text as it
 * streams. Resolves { text, usage, model } or rejects with { status, message }.
 */
function runClaude({ model, prompt, systemPrompt }, onDelta) {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
      "--model", model,
    ];
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    if (ALLOWED_TOOLS.length) args.push("--allowed-tools", ...ALLOWED_TOOLS);
    if (DISALLOWED_TOOLS.length) args.push("--disallowed-tools", ...DISALLOWED_TOOLS);

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"], cwd: CWD });
    } catch (err) {
      reject({ status: 500, message: `failed to spawn ${CLAUDE_BIN}: ${err.message}` });
      return;
    }

    let settled = false;
    let buffer = "";
    let stderr = "";
    let streamed = "";
    let fallbackText = "";
    let resolvedModel = model;
    let usage = null;

    const timer = setTimeout(() => {
      fail({ status: 504, message: `claude timed out after ${RUN_TIMEOUT_MS}ms` });
    }, RUN_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch (_) { /* already exited */ }
    }
    function done(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function handleEvent(ev) {
      if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string") {
        resolvedModel = ev.model;
        return;
      }
      if (ev.error === "model_not_found") {
        fail({
          status: 404,
          code: "model_not_found",
          message: `Model '${model}' is not available to this Claude account.`,
        });
        return;
      }
      if (ev.type === "stream_event" && ev.event) {
        const inner = ev.event;
        if (inner.type === "message_start" && inner.message && inner.message.model) {
          resolvedModel = inner.message.model;
        }
        if (
          inner.type === "content_block_delta" &&
          inner.delta &&
          inner.delta.type === "text_delta" &&
          typeof inner.delta.text === "string"
        ) {
          streamed += inner.delta.text;
          if (onDelta) onDelta(inner.delta.text);
        }
        return;
      }
      if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
        // Non-partial fallback: only text blocks, never thinking blocks.
        fallbackText = ev.message.content
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("");
        return;
      }
      if (ev.type === "result") {
        if (ev.is_error || ev.api_error_status) {
          const message = typeof ev.result === "string" ? ev.result : "Claude CLI returned an error";
          fail({ status: ev.api_error_status === 404 ? 404 : 502, message });
          return;
        }
        usage = ev.usage || null;
        const text = streamed || (typeof ev.result === "string" ? ev.result : fallbackText);
        done({ text: text || "", usage, model: resolvedModel });
      }
    }

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (_) { continue; }
        handleEvent(ev);
        if (settled) return;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on("error", (err) => fail({ status: 500, message: err.message }));
    child.on("close", (code) => {
      if (settled) return;
      const text = streamed || fallbackText;
      if (text) { done({ text, usage, model: resolvedModel }); return; }
      fail({
        status: 502,
        message: `claude exited with code ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`,
      });
    });

    child.stdin.on("error", () => { /* closed early; close handler reports it */ });
    child.stdin.end(prompt, "utf8");
  });
}

// ----------------------------------------------------------------- helpers --

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, code) {
  if (res.headersSent) { res.end(); return; }
  sendJson(res, status, {
    error: { message, type: code || "invalid_request_error", code: code || null },
  });
}

function completionId() {
  return `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
}

function toUsage(raw) {
  const u = raw || {};
  const prompt = Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
  const completion = Number(u.output_tokens || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

// ---------------------------------------------------------------- handlers --

async function handleChatCompletions(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch (_) {
    sendError(res, 400, "Request body is not valid JSON.");
    return;
  }

  const model = typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : "opus";
  const { prompt, systemPrompt } = buildInput(payload.messages);
  if (!prompt && !systemPrompt) {
    sendError(res, 400, "No usable message content in request.");
    return;
  }

  const stream = payload.stream === true;
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  let sent = 0;

  await acquire();
  try {
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const emit = (delta, finish) => {
        res.write(`data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish || null }],
        })}\n\n`);
      };
      emit({ role: "assistant", content: "" });
      const result = await runClaude({ model, prompt, systemPrompt }, (text) => {
        sent += text.length;
        emit({ content: text });
      });
      if (result.text.length > sent) emit({ content: result.text.slice(sent) });
      emit({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const result = await runClaude({ model, prompt, systemPrompt }, null);
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: result.model || model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: result.text },
        finish_reason: "stop",
      }],
      usage: toUsage(result.usage),
    });
  } catch (err) {
    const status = err && err.status ? err.status : 502;
    const message = err && err.message ? err.message : "Claude CLI request failed";
    log(`chat error (${status}) model=${model}: ${message}`);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      sendError(res, status, message, err && err.code);
    }
  } finally {
    release();
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const route = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (route === "/health" || route === "/v1/health")) {
    const current = catalog;
    const auth = authSnapshot();
    const stale = current ? !discovery.isFresh(current) : true;
    // "ok" must mean requests will actually succeed. Anything else is degraded.
    const status = auth.loggedIn === false ? "degraded" : auth.loggedIn === null ? "unknown" : "ok";
    sendJson(res, status === "degraded" ? 503 : 200, {
      status,
      auth: { loggedIn: auth.loggedIn, detail: auth.detail, checkedAt: new Date(auth.checkedAt).toISOString() },
      ...(status === "degraded" ? { error: auth.detail } : {}),
      ...(stale && status !== "degraded" ? { warning: "model catalog is stale" } : {}),
      provider: "claude-code-cli",
      models: current ? current.models.length : 0,
      cliVersion: current ? current.cliVersion : null,
      catalogGeneratedAt: current ? current.generatedAt : null,
      catalogFresh: discovery.isFresh(current),
      activeRuns: active,
      queued: waiting.length,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === "GET" && (route === "/v1/models" || route === "/models")) {
    sendJson(res, 200, {
      object: "list",
      data: modelList().map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: "anthropic",
        ...(m.resolvedId ? { resolved_id: m.resolvedId } : {}),
      })),
    });
    return;
  }

  if (req.method === "POST" && (route === "/v1/chat/completions" || route === "/chat/completions")) {
    const chunks = [];
    let size = 0;
    req.on("error", () => { try { res.destroy(); } catch (_) { /* gone */ } });
    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 64 * 1024 * 1024) { req.destroy(); }
    });
    req.on("end", () => {
      handleChatCompletions(req, res, Buffer.concat(chunks, size).toString("utf8")).catch((err) => {
        log(`unhandled: ${err && err.message}`);
        sendError(res, 500, "Internal proxy error.");
      });
    });
    return;
  }

  sendError(res, 404, `Unsupported ${req.method} ${route}`, "not_found");
});

server.headersTimeout = 0;
server.requestTimeout = 0;
server.setTimeout(0);
server.on("error", (err) => {
  console.error(`[proxy] fatal: ${err.message}`);
  process.exit(1);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (cwd ${CWD}, max ${MAX_CONCURRENT} concurrent)`);
  refreshAuth(); // so the first /health after a restart already knows the truth
  ensureCatalog();
});
