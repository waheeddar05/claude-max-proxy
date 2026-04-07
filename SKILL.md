---
name: claude-max-proxy
description: Route OpenClaw through a Claude Max/Pro/Team subscription using the claude-max-api-proxy (wraps Claude Code CLI auth as an OpenAI-compatible endpoint). Use when setting up OpenClaw to use a Claude subscription instead of API keys, configuring the proxy LaunchAgent, troubleshooting proxy connectivity, verifying billing/usage, or checking proxy health. Triggers on phrases like "use my Claude subscription", "set up Claude proxy", "route through Claude Code", "Claude Max proxy", "subscription billing check".
---

# Claude Max Proxy

Route OpenClaw LLM traffic through your Claude Max/Pro/Team subscription via `claude-max-api-proxy`, which wraps Claude Code CLI authentication as an OpenAI-compatible API endpoint.

## How It Works

```
OpenClaw → http://localhost:3456/v1 → claude-max-api-proxy → Claude Code CLI → Anthropic (subscription)
```

The proxy translates OpenAI-compatible API calls into Claude Code CLI invocations, using the CLI's existing subscription auth. This means OpenClaw traffic bills against your Claude subscription quota rather than consuming API key credits.

## Prerequisites

- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude auth login`)
- Active Claude Max, Pro, or Team subscription
- Node.js 18+

## Setup

Run the setup script:

```bash
bash scripts/setup-proxy.sh
```

This will:
1. Verify Claude Code CLI is installed and authenticated
2. Install `claude-max-api-proxy` globally via npm
3. Create a macOS LaunchAgent for auto-start and keep-alive
4. Verify the proxy is running

### Configure OpenClaw

After the proxy is running, update OpenClaw config:

- **Primary model:** `openai/claude-opus-4` (routes through proxy)
- **Fallback:** `anthropic/claude-opus-4-6` (API key, if proxy is down)
- **Set env:** `OPENAI_BASE_URL=http://localhost:3456/v1`

Restart the gateway (`openclaw gateway restart`) and start a new session.

## Health Check

```bash
curl -s http://localhost:3456/health
curl -s http://localhost:3456/v1/models
```

## Verify Billing

To confirm proxy traffic counts against your subscription (not billed separately):

1. Note usage % at [claude.ai/settings/billing](https://claude.ai/settings/billing)
2. Use OpenClaw or send test requests through the proxy
3. Refresh billing — if % increased, it's using your subscription quota ✅

> **Note (April 2026):** Anthropic restricts third-party OAuth-based subscription access. This proxy uses Claude Code CLI auth (first-party tool), which has been verified to count against normal subscription quota without extra billing.

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md) for common issues: proxy not responding, auth expiry, OpenClaw still using API key, port conflicts, and billing verification steps.
