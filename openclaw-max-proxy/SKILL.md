---
name: openclaw-max-proxy
description: Route OpenClaw through a Claude Max/Pro/Team subscription by driving the Claude Code CLI behind an OpenAI-compatible proxy, with a model catalog discovered live from the CLI so new releases appear automatically. Use when setting up OpenClaw to use a Claude subscription instead of API keys, configuring the proxy or model-sync LaunchAgents, troubleshooting proxy connectivity, verifying billing/usage, or fixing model problems. Trigger on "openclaw config", "openclaw provider", "claude-proxy", "bridge proxy", "content array", "[object Object]" in agent replies, "model not showing", "I can't see Opus 5", "Unknown model", "Model override is not allowed", "Cannot find module" in gateway logs, or gateway "Internal Server Error".
---

# OpenClaw on a Claude subscription, with a live model catalog

Route OpenClaw's LLM traffic through a Claude Max/Pro/Team subscription instead of a paid
API key, and keep the model list current without hand-editing config.

```
OpenClaw gateway :18789 → claude-proxy :3457 → claude --print → Anthropic (subscription)
                              ↑
                    claude-models.json (discovered)
                              ↑
                    model-sync (timer) → openclaw config patch
```

`claude-proxy.js` is a self-contained OpenAI-compatible server. It flattens structured
`content` arrays, passes the requested model id to `claude --model` **verbatim**, and
streams SSE back. The Claude Code CLI supplies subscription auth, so traffic bills against
the subscription rather than API credits.

## Do not use claude-max-api-proxy

Earlier versions of this skill wrapped the npm package `claude-max-api-proxy` and put a
content-flattening bridge in front of it. Do not. That proxy hardcodes three model ids
(`claude-opus-4`, `claude-sonnet-4`, `claude-haiku-4`), has no route for other families
such as `fable`, and **silently coerces every unrecognised model to opus** — you get
answers from the wrong model with no error. Its `MODEL_MAP` is a lookup table returning
wrong values; no wrapper can fix that. `scripts/claude-proxy.js` replaces it entirely.

(If you meet an existing install: the npm package is `claude-max-api-proxy` but the binary
is `claude-max-api`, and the port is a positional arg — `claude-max-api 3456`, not
`--port 3456`. Retire it rather than repairing it.)

## Setup

```bash
bash scripts/setup.sh
```

Prerequisites: Node 18+, and Claude Code CLI installed and authenticated
(`npm install -g @anthropic-ai/claude-code && claude auth login`; check with
`claude auth status` — expect `"subscriptionType": "max"` or `pro`/`team`).

The installer copies the three scripts to `~/.openclaw/`, installs two LaunchAgents
(`com.openclaw.claude-proxy` KeepAlive on :3457, `com.openclaw.model-sync` every 6h),
runs a first discovery, and patches `openclaw.json`. It is idempotent.

## Model discovery — the part that matters

Model ids in the catalog are **Anthropic's own, verbatim**. No aliases, prefixes, or
invented labels. Discovery treats the Claude Code CLI as the source of truth:

1. **Mine** candidate ids out of the installed CLI bundle (`grep -a` over the package,
   native binary included).
2. **Probe forward.** For each family, generate ids one to two releases past the newest
   known (`claude-opus-5`, `claude-opus-6`, `claude-opus-5-0`, …) and probe them on every
   refresh. This is essential: **the CLI bundle only contains models that existed when it
   was built.** Models ship server-side with no CLI update — `claude-opus-5` did — and
   mining alone can never see them. Guessing is free: a non-existent id returns
   `model_not_found` / HTTP 404 with zero tokens billed.
3. **Validate** each candidate with `claude --print`, killing the process at the first
   token, so a valid model costs a handful of tokens and a full re-probe costs very little.
4. **Resolve aliases.** `opus`/`sonnet`/`haiku`/`fable` are probed to record what they
   currently point at, kept as metadata only. Do not configure aliases as models: at the
   time of writing `opus` resolves to `claude-opus-4-8`, **not** `claude-opus-5`, so an
   alias-based config quietly pins you to an older model while looking current.
5. **Filter dishonest ids.** The CLI silently upgrades retired ids (`claude-opus-4-1` →
   `claude-opus-4-8`). Those are recorded in `superseded` and not advertised, so every id
   in the catalog answers as itself.
6. **Sticky removal.** A model already in the catalog only leaves after 2 consecutive
   failed refreshes (`misses` counter), so one flaky night cannot shrink the list.

Cached 12h; a CLI version change forces a full re-probe regardless of age.

`claude-models-sync.js` then writes the catalog into `openclaw.json` — provider list,
the `agents.defaults.models` allowlist, and primary/fallbacks — and reloads the gateway,
only when something changed. **The primary auto-tracks the newest release** in
`OPENCLAW_PRIMARY_FAMILY` (default `opus`) by numeric version comparison. Pin it with
`OPENCLAW_PIN_PRIMARY=claude-opus-5` in the model-sync LaunchAgent.

## OpenClaw config rules

- Provider key must be `claude-proxy`. Never `openai` — that collides with the built-in
  provider and 404s.
- `"api": "openai-completions"` is required.
- Model entries need both `id` and `name`.
- Do **not** set `OPENAI_API_KEY` / `OPENAI_BASE_URL` in `env`. The provider block carries
  its own credentials and a global `OPENAI_BASE_URL` hijacks any real OpenAI provider later.
- Never hand-edit `openclaw.json`. Use `openclaw config patch` (schema-validated) and
  `openclaw config validate`.
- Shrinking an array via patch needs `--replace-path models.providers.claude-proxy.models`, or OpenClaw refuses:
  `Refusing to replace ...; it would remove existing entries`.
- OpenClaw only auto-discovers models for LM Studio / Ollama / OpenRouter. For a custom
  `openai-completions` provider the config list is authoritative — hence model-sync.

| Symptom | Cause | Fix |
|---|---|---|
| `Unknown model: openai/...` | no `models.providers` block | add the provider config |
| `expected array, received object` | models is an object | array of `{id, name}` |
| HTTP 404 from the proxy | missing `api` adapter or wrong provider key | `"api": "openai-completions"`, key `claude-proxy` |
| `[object Object]` in replies | content arrays not flattened | use `claude-proxy.js` |
| `Model override "x" is not allowed` | id missing from `agents.defaults.models` | run model-sync |
| A model is missing | catalog stale, or id beyond forward-probe range | `node ~/.openclaw/claude-models-discover.js --force`, else add it to `~/.openclaw/claude-models-extra.txt` |

## Health checks

```bash
curl -s http://127.0.0.1:3457/health          # status, model count, cli version, freshness
curl -s http://127.0.0.1:3457/v1/models
curl -s http://127.0.0.1:18789/health         # {"ok":true,"status":"live"}
openclaw models status
openclaw agent --message "Reply with exactly: ready"
node ~/.openclaw/claude-models-sync.js --dry-run
```

Content-array regression test — must return real text, not `[object Object]`:

```bash
curl -s -X POST http://127.0.0.1:3457/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-5","messages":[{"role":"user","content":[{"type":"text","text":"say pong"}]}]}'
```

## Limits worth stating up front

- **No `tool_calls` support in either direction.** OpenClaw's tool layer, `tools.profile`,
  exec approvals and `gateway.nodes.denyCommands` are not what executes. Agentic work is
  performed by the Claude Code CLI subprocess using *its* built-in tools and *its*
  permissions from `~/.claude/settings.json`. Restrict with
  `CLAUDE_PROXY_ALLOWED_TOOLS` / `CLAUDE_PROXY_DISALLOWED_TOOLS` if that matters.
- No native multi-turn message array upstream: system messages go via
  `--append-system-prompt`, the transcript is rendered into one prompt delivered on
  **stdin** (not argv, so long histories cannot hit `ARG_MAX`).
- The CLI subprocess inherits the proxy's cwd; the LaunchAgent pins it to
  `~/.openclaw/workspace` so relative-path work does not land at `/`.
- OpenClaw also ships a native `claude-cli` agent runtime that would remove this proxy
  entirely, but it requires `openclaw models auth setup-token` — interactive TTY, and a
  long-lived token rather than the CLI subprocess. Worth evaluating where a TTY exists.

## Verify billing

Note usage % at [claude.ai/settings/billing](https://claude.ai/settings/billing), send
traffic through OpenClaw, refresh. An increase means it drew on the subscription quota.

See [references/troubleshooting.md](references/troubleshooting.md) for LaunchAgent
failures, gateway module errors after OpenClaw updates, and diagnosing missing models.
