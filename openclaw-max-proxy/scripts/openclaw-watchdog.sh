#!/bin/bash
# Re-load OpenClaw LaunchAgents that were unloaded out from under launchd.
#
# KeepAlive only restarts a service that *crashed*. An `openclaw` upgrade boots
# the gateway out of launchd entirely and does not always put it back, which
# leaves the plist on disk, the service absent, and nothing to restart it — the
# dashboard just stops answering. This re-bootstraps anything missing, and
# kickstarts anything loaded but not listening.
#
# Runs from com.openclaw.watchdog every 5 minutes.
set -u

UID_N="$(id -u)"
LA="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.openclaw/logs"      # not /tmp — macOS clears that
LOG="$LOG_DIR/watchdog.log"
mkdir -p "$LOG_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# Trim the log so it cannot grow without bound.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then
  tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# A service counts as reachable if it answers HTTP at all. The proxy returns 503
# when the Claude CLI is logged out — that is a credential problem, not a dead
# process, and restarting it would be a pointless loop.
reachable() { curl -s -o /dev/null --max-time 5 "$1" >/dev/null 2>&1; }

check() {
  label="$1"; url="$2"; plist="$LA/$label.plist"

  if [ ! -f "$plist" ]; then
    log "SKIP $label: no plist at $plist"
    return
  fi

  if ! launchctl print "gui/$UID_N/$label" >/dev/null 2>&1; then
    log "MISSING $label: not registered with launchd — bootstrapping"
    launchctl bootstrap "gui/$UID_N" "$plist" >/dev/null 2>&1
    sleep 5
    if reachable "$url"; then log "RECOVERED $label"; else log "FAILED $label: still not answering $url"; fi
    return
  fi

  if [ -n "$url" ] && ! reachable "$url"; then
    log "UNRESPONSIVE $label: loaded but $url refused — kickstarting"
    launchctl kickstart -k "gui/$UID_N/$label" >/dev/null 2>&1
    sleep 5
    if reachable "$url"; then log "RECOVERED $label"; else log "FAILED $label: still not answering $url"; fi
  fi
}

check ai.openclaw.gateway      "http://127.0.0.1:18789/health"
check com.openclaw.claude-proxy "http://127.0.0.1:3457/health"
