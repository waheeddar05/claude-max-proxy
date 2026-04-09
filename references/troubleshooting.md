# Troubleshooting

## Proxy Not Responding

```bash
# Check if process is running
curl -s http://localhost:3456/health

# Check LaunchAgent status (macOS)
launchctl print gui/$(id -u)/com.claude-max-api 2>&1 | head -10

# Check logs
cat /tmp/claude-max-api.out.log
cat /tmp/claude-max-api.err.log

# Restart
launchctl kickstart -k gui/$(id -u)/com.claude-max-api
```

## Claude Code Auth Expired

```bash
# Check auth status
claude auth status

# Re-authenticate
claude auth login
# Then restart proxy
launchctl kickstart -k gui/$(id -u)/com.claude-max-api
```

## OpenClaw Still Using API Key

- Verify config has `claude-proxy/claude-opus-4` as primary model (not `openai/...`)
- Verify `OPENAI_BASE_URL=http://localhost:3457/v1` points to bridge proxy (port 3457)
- Config hot-reloads, but start a new session (`/new`) — existing sessions keep their original model

## [object Object] in Agent Replies

This means content arrays aren't being flattened. The bridge proxy is either not running or OpenClaw is bypassing it.

```bash
# Check bridge proxy is running
lsof -i :3457

# If not running, start it
node ~/.openclaw/claude-proxy-bridge.js &

# Verify config points to bridge (port 3457, not 3456)
grep "baseUrl" ~/.openclaw/openclaw.json
grep "OPENAI_BASE_URL" ~/.openclaw/openclaw.json

# Test bridge directly with a content array
curl -s -X POST http://127.0.0.1:3457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4","messages":[{"role":"user","content":[{"type":"text","text":"say pong"}]}],"max_tokens":50}'
```

If the bridge test returns a response with `"content":"pong"`, the bridge is working. If you still see `[object Object]` in webchat, the OpenClaw config's `baseUrl` is probably still pointing to port 3456.

## Gateway "Internal Server Error" After Update

OpenClaw updates can introduce new channel plugins with missing dependencies. Every HTTP request fails because `listBundledChannelPlugins` loads ALL plugins.

```bash
# Find which modules are missing
grep "Cannot find module" ~/.openclaw/logs/gateway.err.log | \
  sed "s/.*Cannot find module '\([^']*\)'.*/\1/" | sort -u

# Install them (adjust path for your installation)
cd /opt/homebrew/lib/node_modules/openclaw
npm install <module1> <module2> ...

# Restart gateway
kill -USR1 $(pgrep -f openclaw-gateway)

# Verify
curl -s http://127.0.0.1:18789/health
```

Known commonly missing modules (as of v2026.4.x):
- `@buape/carbon` (Discord plugin)
- `@larksuiteoapi/node-sdk` (Feishu/Lark plugin)
- `@slack/web-api` (Slack plugin)
- `grammy` (Telegram plugin)

If reinstalling OpenClaw (`npm install -g openclaw@<version>`), note that it wipes manually installed peer deps — you'll need to install the channel plugin deps again.

## Verifying Proxy Traffic Counts Against Subscription

1. Note current usage % at claude.ai/settings/billing
2. Send test requests through the proxy:
   ```bash
   curl -s -X POST http://localhost:3456/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-opus-4","messages":[{"role":"user","content":"Write 500 words about anything."}],"max_tokens":1000}'
   ```
3. Refresh billing page — if % increased, proxy traffic counts against your plan (good)
4. If % unchanged, traffic may be billed separately as "Extra Usage"

## Port Conflict

Change ports via environment variables before running setup:
```bash
PROXY_PORT=3456 bash scripts/setup-proxy.sh
BRIDGE_PORT=3457 UPSTREAM_PORT=3456 bash scripts/setup-bridge.sh
```
Then update `OPENAI_BASE_URL` in OpenClaw config accordingly.

## WhatsApp Gateway Disconnecting Every ~30 Minutes

You may see repeated disconnect/reconnect cycles in the OpenClaw logs or UI:

```
WhatsApp gateway disconnected (status 499)
WhatsApp gateway connected as +919860106704.
WhatsApp gateway disconnected (status 503)
WhatsApp gateway connected as +919860106704.
```

This is **normal behavior**. WhatsApp's Web API enforces periodic session refreshes. The status codes (499, 503, 428) reflect different server-side reasons for the disconnect, but the gateway auto-reconnects within a few seconds each time.

**When to worry:**
- Reconnection takes longer than 30 seconds
- The gateway stops reconnecting entirely (no "connected" line after a disconnect)
- You see the same status code repeatedly with no recovery (e.g., 401 means auth expired)

**If it stops reconnecting:**
```bash
# Check WhatsApp channel status in gateway logs
tail -50 ~/.openclaw/logs/gateway.log | grep whatsapp

# Restart the gateway
kill -USR1 $(pgrep -f openclaw-gateway)
```

## Bridge Proxy Not Running After Reboot

If the bridge proxy LaunchAgent wasn't set up, it won't survive reboots. Install it:

```bash
# Check if LaunchAgent exists
ls ~/Library/LaunchAgents/com.openclaw.bridge-proxy.plist

# If missing, create it (see scripts/setup-bridge.sh) or run:
bash scripts/setup-bridge.sh

# If it exists but isn't running
launchctl kickstart -k gui/$(id -u)/com.openclaw.bridge-proxy

# Check logs
cat /tmp/claude-bridge-proxy.out.log
cat /tmp/claude-bridge-proxy.err.log
```

## Diagnostic Commands Cheat Sheet

```bash
# Full chain verification
curl -s http://localhost:3456/health                   # Upstream proxy
curl -s http://127.0.0.1:3457/v1/models               # Bridge proxy
curl -s http://127.0.0.1:18789/health                  # OpenClaw gateway

# Process check
ps aux | grep claude-proxy-bridge | grep -v grep       # Bridge proxy process
ps aux | grep openclaw-gateway | grep -v grep          # Gateway process

# Logs
tail -30 ~/.openclaw/logs/gateway.log                  # Gateway main log
tail -30 ~/.openclaw/logs/gateway.err.log              # Gateway error log
cat /tmp/claude-bridge-proxy.out.log                   # Bridge proxy log
cat /tmp/claude-max-api.out.log                        # Upstream proxy log

# Restart gateway (graceful)
kill -USR1 $(pgrep -f openclaw-gateway)
```
