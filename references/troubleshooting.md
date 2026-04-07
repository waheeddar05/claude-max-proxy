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

- Verify config has `openai/claude-opus-4` as primary model
- Verify `OPENAI_BASE_URL=http://localhost:3456/v1` is set
- Restart OpenClaw gateway: `openclaw gateway restart`
- Start a new session (`/new`) — existing sessions keep their original model

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

Change port via `PROXY_PORT` env var before running setup:
```bash
PROXY_PORT=3457 bash scripts/setup-proxy.sh
```
Then update `OPENAI_BASE_URL` accordingly.
