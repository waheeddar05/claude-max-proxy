#!/usr/bin/env bash
# Setup claude-max-api-proxy: routes OpenClaw through Claude Code CLI auth (Max/Pro/Team subscription)
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

PORT="${PROXY_PORT:-3456}"
PLIST_LABEL="com.claude-max-api"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# 1. Check Claude Code CLI
if ! command -v claude &>/dev/null; then
  error "Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code"
  exit 1
fi
info "Claude Code CLI found: $(which claude)"

# 2. Check Claude Code auth
if ! claude auth status 2>&1 | grep -qi "logged in\|authenticated\|active"; then
  warn "Claude Code may not be authenticated. Run: claude auth login"
  read -p "Continue anyway? (y/n) " -n 1 -r; echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi
info "Claude Code auth looks good"

# 3. Install proxy
if ! command -v claude-max-api-proxy &>/dev/null; then
  info "Installing claude-max-api-proxy..."
  npm install -g claude-max-api-proxy
else
  info "claude-max-api-proxy already installed"
fi

# 4. Test proxy starts
info "Testing proxy on port $PORT..."
claude-max-api-proxy --port "$PORT" &
PROXY_PID=$!
sleep 3

if curl -s "http://localhost:$PORT/health" | grep -q '"ok"'; then
  info "Proxy health check passed"
else
  error "Proxy failed to start. Check logs."
  kill $PROXY_PID 2>/dev/null
  exit 1
fi
kill $PROXY_PID 2>/dev/null
sleep 1

# 5. Create LaunchAgent (macOS)
if [[ "$(uname)" == "Darwin" ]]; then
  PROXY_BIN=$(which claude-max-api-proxy)
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${PROXY_BIN}</string>
        <string>--port</string>
        <string>${PORT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-max-api.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-max-api.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF
  info "LaunchAgent created at $PLIST_PATH"

  # Load it
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  info "LaunchAgent loaded and running"
else
  warn "Not macOS — skipping LaunchAgent. Run manually: claude-max-api-proxy --port $PORT"
fi

# 6. Verify
sleep 2
if curl -s "http://localhost:$PORT/health" | grep -q '"ok"'; then
  info "Proxy running on http://localhost:$PORT"
else
  error "Proxy not responding after launch. Check: cat /tmp/claude-max-api.err.log"
  exit 1
fi

echo ""
echo "=== Next Steps ==="
echo "Configure OpenClaw to use the proxy. Add to your openclaw config:"
echo ""
echo "  models:"
echo "    primary: openai/claude-opus-4"
echo "    fallback: anthropic/claude-opus-4-6"
echo ""
echo "  Set OPENAI_BASE_URL=http://localhost:${PORT}/v1"
echo ""
echo "Health check:  curl -s http://localhost:${PORT}/health"
echo "Test models:   curl -s http://localhost:${PORT}/v1/models"
echo "Logs:          cat /tmp/claude-max-api.out.log"
