---
name: claude-max-proxy
description: >-
  Route OpenClaw through a Claude Max/Pro/Team subscription using the claude-max-api-proxy
  (wraps Claude Code CLI auth as an OpenAI-compatible endpoint). Use when setting up OpenClaw
  to use a Claude subscription instead of API keys, configuring the proxy LaunchAgent,
  troubleshooting proxy connectivity, verifying billing/usage, checking proxy health,
  fixing the [object Object] content serialization bug in webchat, or resolving missing
  Node.js module errors after OpenClaw updates. Also trigger on "openclaw config",
  "openclaw provider", "bridge proxy", "content array", "claude-proxy-bridge",
  "Cannot find module" in gateway logs, or gateway "Internal Server Error".
---

# Claude Max Proxy

Route OpenClaw LLM traffic through your Claude Max/Pro/Team subscription via `claude-max-api-proxy`, which wraps Claude Code CLI authentication as an OpenAI-compatible API endpoint.

## How It Works

```
OpenClaw → Bridge Proxy (:3457) → claude-max-api-proxy (:3456) → Claude Code CLI → Anthropic (subscription)
```

The proxy translates OpenAI-compatible API calls into Claude Code CLI invocations, using the CLI's existing subscription auth. This means OpenClaw traffic bills against your Claude subscription quota rather than consuming API key credits.

The bridge proxy (port 3457) sits between OpenClaw and the upstream proxy to fix a content format mismatch — see "Bridge Proxy" section below.

## Prerequisites

- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude auth login`)
- Active Claude Max, Pro, or Team subscription
- Node.js 18+

## Setup

### 1. Install and start the upstream proxy

Run the setup script:

```bash
bash scripts/setup-proxy.sh
```

This will:
1. Verify Claude Code CLI is installed and authenticated
2. Install `claude-max-api-proxy` globally via npm
3. Create a macOS LaunchAgent for auto-start and keep-alive
4. Verify the proxy is running on port 3456

### 2. Deploy the bridge proxy

OpenClaw's webchat sends message content as structured arrays (Anthropic format):
```json
{"role": "user", "content": [{"type": "text", "text": "Hello"}]}
```

But the Claude proxy only handles plain string content. Without the bridge, the proxy receives `[object Object]` instead of the actual message text.

The bridge proxy intercepts `/chat/completions` requests and flattens content arrays to plain strings before forwarding upstream.

```bash
# Copy the bridge script
cp scripts/claude-proxy-bridge.js ~/.openclaw/claude-proxy-bridge.js

# Start it
node ~/.openclaw/claude-proxy-bridge.js &

# Verify (should return a real response, not [object Object])
curl -s -X POST http://127.0.0.1:3457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4","messages":[{"role":"user","content":[{"type":"text","text":"say pong"}]}],"max_tokens":50}'
```

For persistence on macOS, set up a LaunchAgent (see `scripts/setup-bridge.sh`) or add `node ~/.openclaw/claude-proxy-bridge.js &` to a startup script.

### 3. Configure OpenClaw

Edit `~/.openclaw/openclaw.json` (hot-reloads automatically). The critical details:

- **Provider key**: Use `claude-proxy` (NOT `openai` — OpenClaw has a built-in `openai` provider that would conflict and cause 404s)
- **API adapter**: Must be `"openai-completions"` — without this, OpenClaw doesn't know which request format to use
- **baseUrl**: Point to the bridge proxy on port 3457, not the upstream proxy on 3456
- **Model entries**: Must be objects with both `id` and `name` fields

Add under `models.providers`:

```json
"claude-proxy": {
  "baseUrl": "http://localhost:3457/v1",
  "apiKey": "not-needed",
  "models": [
    {"id": "claude-opus-4", "name": "claude-opus-4", "contextWindow": 200000, "maxTokens": 16384},
    {"id": "claude-sonnet-4", "name": "claude-sonnet-4", "contextWindow": 200000, "maxTokens": 16384},
    {"id": "claude-haiku-4", "name": "claude-haiku-4", "contextWindow": 200000, "maxTokens": 16384}
  ],
  "api": "openai-completions"
}
```

Set the agent defaults:

```json
"agents": {
  "defaults": {
    "model": {
      "primary": "claude-proxy/claude-opus-4",
      "fallbacks": []
    },
    "models": {
      "claude-proxy/claude-opus-4": {},
      "claude-proxy/claude-sonnet-4": {}
    }
  }
}
```

Set environment variables:

```json
"env": {
  "OPENAI_API_KEY": "not-needed",
  "OPENAI_BASE_URL": "http://localhost:3457/v1"
}
```

### Common config errors

| Error message | Cause | Fix |
|---|---|---|
| `Unknown model: openai/claude-opus-4` | No `models.providers` section | Add the provider config block |
| `expected array, received object` for models | Models is an object, not array | Use array of `{id, name}` objects |
| `expected string, received undefined` for `.name`/`.id` | Missing required fields | Include both `id` and `name` |
| HTTP 404 from proxy | Missing `api` adapter or wrong provider name | Add `"api": "openai-completions"` and use `claude-proxy` key |
| `[object Object]` in agent replies | Content arrays not flattened | Deploy bridge proxy on port 3457 |

## Health Check

```bash
# Upstream Claude proxy
curl -s http://localhost:3456/health

# Bridge proxy (send content array, expect real response)
curl -s -X POST http://127.0.0.1:3457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4","messages":[{"role":"user","content":[{"type":"text","text":"say pong"}]}],"max_tokens":50}'

# OpenClaw gateway
curl -s http://127.0.0.1:18789/health

# Available models
curl -s http://localhost:3456/v1/models
```

## Verify Billing

To confirm proxy traffic counts against your subscription (not billed separately):

1. Note usage % at [claude.ai/settings/billing](https://claude.ai/settings/billing)
2. Use OpenClaw or send test requests through the proxy
3. Refresh billing — if % increased, it's using your subscription quota

> **Note (April 2026):** Anthropic restricts third-party OAuth-based subscription access. This proxy uses Claude Code CLI auth (first-party tool), which has been verified to count against normal subscription quota without extra billing.

## Fixing Gateway Errors After OpenClaw Updates

OpenClaw updates sometimes introduce new channel plugin extensions (Discord, Telegram, Feishu, etc.) with unresolved dependencies. The symptom is the gateway returning "Internal Server Error" on every request, with errors like `Cannot find module '@buape/carbon'`.

This happens because `listBundledChannelPlugins` loads ALL channel plugins on every request — if any one is missing a dependency, every request fails.

### Fix: install missing modules iteratively

```bash
cd /opt/homebrew/lib/node_modules/openclaw  # adjust for your install path

# Find all missing modules
grep "Cannot find module" ~/.openclaw/logs/gateway.err.log | \
  sed "s/.*Cannot find module '\([^']*\)'.*/\1/" | sort -u

# Install them all at once
npm install @buape/carbon @larksuiteoapi/node-sdk @slack/web-api grammy

# Restart gateway
kill -USR1 $(pgrep -f openclaw-gateway)
```

Hit `/health` again. If a new module is missing, install it and restart. Repeat until it returns `{"ok":true,"status":"live"}`.

Known commonly missing modules (as of v2026.4.x): `@buape/carbon` (Discord), `@larksuiteoapi/node-sdk` (Feishu), `@slack/web-api` (Slack), `grammy` (Telegram).

If many modules are missing, reinstalling OpenClaw (`npm install -g openclaw@<version>`) gives a clean slate, but you'll still need to install the channel plugin dependencies afterward.

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md) for more detailed troubleshooting: proxy not responding, auth expiry, OpenClaw still using API key, port conflicts, billing verification, and diagnostic commands.
