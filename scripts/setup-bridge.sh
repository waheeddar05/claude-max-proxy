#!/usr/bin/env bash
# Setup the bridge proxy as a macOS LaunchAgent for auto-start and keep-alive.
# The bridge flattens OpenAI content arrays before forwarding to the upstream proxy.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

BRIDGE_PORT="${BRIDGE_PORT:-3457}"
UPSTREAM_PORT="${UPSTREAM_PORT:-3456}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_SCRIPT="$SCRIPT_DIR/claude-proxy-bridge.js"
DEST="$HOME/.openclaw/claude-proxy-bridge.js"
PLIST_LABEL="com.openclaw.bridge-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# 1. Check Node.js
if ! command -v node &>/dev/null; then
  error "Node.js not found. Install it first."
  exit 1
fi
info "Node.js found: $(node --version)"

# 2. Check upstream proxy is reachable
if curl -sf "http://localhost:$UPSTREAM_PORT/health" >/dev/null 2>&1; then
  info "Upstream proxy healthy on port $UPSTREAM_PORT"
else
  warn "Upstream proxy not responding on port $UPSTREAM_PORT — bridge will still be installed but won't work until the upstream is running"
fi

# 3. Copy bridge script
cp "$BRIDGE_SCRIPT" "$DEST"
chmod +x "$DEST"
info "Bridge script installed at $DEST"

# 4. Test bridge starts
info "Testing bridge proxy on port $BRIDGE_PORT..."
UPSTREAM_URL="http://localhost:$UPSTREAM_PORT" BRIDGE_PORT="$BRIDGE_PORT" node "$DEST" &
BRIDGE_PID=$!
sleep 2

if curl -sf "http://localhost:$BRIDGE_PORT/v1/models" >/dev/null 2>&1; then
  info "Bridge proxy health check passed"
else
  warn "Bridge proxy test inconclusive (upstream may not be running)"
fi
kill $BRIDGE_PID 2>/dev/null
sleep 1

# 5. Create LaunchAgent (macOS)
if [[ "$(uname)" == "Darwin" ]]; then
  NODE_BIN=$(which node)
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${DEST}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-bridge-proxy.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-bridge-proxy.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>UPSTREAM_URL</key>
        <string>http://localhost:${UPSTREAM_PORT}</string>
        <key>BRIDGE_PORT</key>
        <string>${BRIDGE_PORT}</string>
    </dict>
</dict>
</plist>
EOF
  info "LaunchAgent created at $PLIST_PATH"

  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  info "LaunchAgent loaded and running"
else
  warn "Not macOS — skipping LaunchAgent. Run manually: node $DEST"
fi

# 6. Verify
sleep 2
if curl -sf "http://localhost:$BRIDGE_PORT/v1/models" >/dev/null 2>&1; then
  info "Bridge proxy running on http://localhost:$BRIDGE_PORT -> http://localhost:$UPSTREAM_PORT"
else
  warn "Bridge proxy may not be fully ready. Check: cat /tmp/claude-bridge-proxy.err.log"
fi

echo ""
echo "=== Bridge Proxy Ready ==="
echo "Make sure your OpenClaw config points to http://localhost:${BRIDGE_PORT}/v1"
echo "Logs: cat /tmp/claude-bridge-proxy.out.log"
