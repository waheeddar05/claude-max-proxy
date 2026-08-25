#!/usr/bin/env bash
# Install the OpenClaw → Claude subscription proxy with live model discovery.
# Idempotent: safe to re-run. macOS (launchd) for the services; the scripts
# themselves are plain Node and run anywhere.
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
die()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OC_DIR="$HOME/.openclaw"
LA_DIR="$HOME/Library/LaunchAgents"
PROXY_PORT="${PROXY_PORT:-3457}"
SYNC_INTERVAL="${SYNC_INTERVAL:-21600}"
GATEWAY_LABEL="${GATEWAY_LABEL:-ai.openclaw.gateway}"

# ---------------------------------------------------------------- prereqs --
command -v node >/dev/null 2>&1 || die "Node.js not found (need 18+)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required, found $(node -v)."
info "Node $(node -v)"

command -v claude >/dev/null 2>&1 || die "Claude Code CLI not found. npm install -g @anthropic-ai/claude-code"
AUTH="$(claude auth status 2>&1 || true)"
echo "$AUTH" | grep -q '"loggedIn": *true' || die "Claude Code CLI is not logged in. Run: claude auth login"
SUB="$(echo "$AUTH" | sed -n 's/.*"subscriptionType": *"\([^"]*\)".*/\1/p')"
[ -n "$SUB" ] && info "Claude CLI authenticated (subscription: $SUB)" || warn "Authenticated, but no subscription type reported — traffic may bill as API usage."

command -v openclaw >/dev/null 2>&1 || die "openclaw not found on PATH."
info "OpenClaw $(openclaw --version 2>&1 | head -1)"

# ------------------------------------------------------------ retire old --
UID_N="$(id -u)"
unload() {
  local label="$1"
  for _ in $(seq 1 15); do
    launchctl print "gui/$UID_N/$label" >/dev/null 2>&1 || return 0
    launchctl bootout "gui/$UID_N/$label" >/dev/null 2>&1 || true
    sleep 1
  done
}
for OLD in com.claude-max-api com.openclaw.bridge-proxy; do
  if launchctl print "gui/$UID_N/$OLD" >/dev/null 2>&1 || [ -f "$LA_DIR/$OLD.plist" ]; then
    unload "$OLD"
    [ -f "$LA_DIR/$OLD.plist" ] && mv "$LA_DIR/$OLD.plist" "$LA_DIR/$OLD.plist.disabled"
    info "retired superseded service $OLD"
  fi
done

# -------------------------------------------------------------- install --
mkdir -p "$OC_DIR" "$LA_DIR" "$OC_DIR/workspace"
for f in claude-proxy.js claude-models-discover.js claude-models-sync.js; do
  cp "$SCRIPT_DIR/$f" "$OC_DIR/$f"
  node --check "$OC_DIR/$f" || die "$f failed a syntax check"
done
info "scripts installed in $OC_DIR"

NODE_BIN="$(command -v node)"

write_plist() {
  local label="$1" plist="$LA_DIR/$1.plist"
  cat > "$plist"
  plutil -lint "$plist" >/dev/null || die "$label plist is malformed"
  unload "$label"
  launchctl bootstrap "gui/$UID_N" "$plist"
  info "loaded $label"
}

write_plist com.openclaw.claude-proxy <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.openclaw.claude-proxy</string>
    <key>ProgramArguments</key>
    <array><string>${NODE_BIN}</string><string>${OC_DIR}/claude-proxy.js</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>WorkingDirectory</key><string>${OC_DIR}/workspace</string>
    <key>StandardOutPath</key><string>/tmp/claude-proxy.out.log</string>
    <key>StandardErrorPath</key><string>/tmp/claude-proxy.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOST</key><string>127.0.0.1</string>
        <key>PORT</key><string>${PROXY_PORT}</string>
        <key>CLAUDE_PROXY_CWD</key><string>${OC_DIR}/workspace</string>
        <key>CLAUDE_PROXY_MAX_CONCURRENT</key><string>4</string>
    </dict>
</dict>
</plist>
EOF

write_plist com.openclaw.model-sync <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.openclaw.model-sync</string>
    <key>ProgramArguments</key>
    <array><string>${NODE_BIN}</string><string>${OC_DIR}/claude-models-sync.js</string></array>
    <key>RunAtLoad</key><true/>
    <key>StartInterval</key><integer>${SYNC_INTERVAL}</integer>
    <key>WorkingDirectory</key><string>${OC_DIR}</string>
    <key>StandardOutPath</key><string>/tmp/openclaw-model-sync.out.log</string>
    <key>StandardErrorPath</key><string>/tmp/openclaw-model-sync.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>OPENCLAW_PROVIDER_BASE_URL</key><string>http://127.0.0.1:${PROXY_PORT}/v1</string>
        <key>OPENCLAW_GATEWAY_LABEL</key><string>${GATEWAY_LABEL}</string>
    </dict>
</dict>
</plist>
EOF

# ------------------------------------------------------------- discover --
echo
info "running first discovery (a few minutes; invalid guesses cost nothing)"
node "$OC_DIR/claude-models-discover.js" --force >/dev/null || die "discovery failed"
COUNT="$(node -e 'const c=require(process.argv[1]);console.log(c.models.length)' "$OC_DIR/claude-models.json")"
info "$COUNT model(s) discovered"

launchctl kickstart -k "gui/$UID_N/com.openclaw.claude-proxy" >/dev/null 2>&1 || true
sleep 3

node "$OC_DIR/claude-models-sync.js" || die "config sync failed"
openclaw config validate

# -------------------------------------------------------------- verify --
echo
for i in $(seq 1 10); do
  curl -sf -m 5 "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null && break
  sleep 2
done
curl -sf -m 5 "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null \
  && info "proxy healthy on :${PROXY_PORT}" \
  || die "proxy not responding. Check: cat /tmp/claude-proxy.err.log"
curl -sf -m 5 http://127.0.0.1:18789/health >/dev/null \
  && info "gateway healthy on :18789" \
  || warn "gateway not responding — start it, then re-run model-sync"

echo
echo "=== Ready ==="
openclaw models status 2>/dev/null | sed -n '1,8p' || true
echo
echo "Smoke test:  openclaw agent --message \"Reply with exactly: ready\""
echo "Force sync:  launchctl kickstart -k gui/$UID_N/com.openclaw.model-sync"
echo "Logs:        /tmp/claude-proxy.{out,err}.log  /tmp/openclaw-model-sync.{out,err}.log"
