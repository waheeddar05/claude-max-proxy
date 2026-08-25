# Troubleshooting

## Nothing works at all

Check `/health` first — it reports auth, not just whether the listener is up:

```bash
curl -s http://127.0.0.1:3457/health   # 503 + status "degraded" when the CLI is logged out
```

`Failed to authenticate: OAuth session expired and could not be refreshed`, or
`All models failed (3): ... (session_expired)` from the gateway, means the Claude
Code CLI's OAuth session lapsed. Nothing in this stack can refresh it — the proxy,
discovery and sync are all fine, they just have no credentials to use. Confirm and
fix:

```bash
claude auth status          # expect "loggedIn": true
claude auth login           # interactive; needs a TTY and a browser
```

Then re-warm the catalog, which will be stale after any long outage:

```bash
node ~/.openclaw/claude-models-discover.js --force
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-proxy
launchctl kickstart -k gui/$(id -u)/com.openclaw.model-sync
```

This expires roughly every few weeks and gives no warning before it does. A run of
`model-sync` logging "no change" is **not** evidence anything works — it only means
the model set did not change, and a totally dead CLI produces exactly that.

## A model is missing (e.g. "I can't see Opus 5")

Work down the pipeline; each step tells you which layer is stale.

```bash
node ~/.openclaw/claude-models-discover.js --force   # 1. is it discoverable?
curl -s http://127.0.0.1:3457/v1/models              # 2. is the proxy serving it?
openclaw models status                               # 3. is it in openclaw.json?
```

1. **Not in discovery.** The id is beyond the forward-probe range, or the probe failed.
   Confirm the model is real by hand:

   ```bash
   claude --print --output-format stream-json --verbose --model claude-opus-5 "hi" < /dev/null | tail -1
   ```

   `"is_error": true` with `"api_error_status": 404` means the account genuinely cannot
   call it. Anything else means discovery missed it — add the id to
   `~/.openclaw/claude-models-extra.txt` (one per line, `#` comments allowed) and re-run.

   Widen the search instead of pinning by raising the generation window in
   `speculativeCandidates()`, or bump `CLAUDE_MAX_CANDIDATES` if the log warns that the
   candidate cap dropped ids.

2. **In discovery, not in `/v1/models`.** The proxy holds the catalog in memory:
   `launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-proxy`.

3. **In `/v1/models`, not in OpenClaw.** Run the sync — OpenClaw does not auto-discover
   models for custom `openai-completions` providers:
   `node ~/.openclaw/claude-models-sync.js` (add `--dry-run` to preview).

### Do not configure aliases as models

`opus`, `sonnet`, `haiku`, `fable` are CLI aliases, not model ids, and they lag. At the
time of writing `opus` resolves to `claude-opus-4-8` while `claude-opus-5` is callable —
an alias-based config silently pins you to the older model. `claude-models.json` records
alias resolution under `aliases` for diagnosis only.

### A model vanished between refreshes

Check `misses` in `~/.openclaw/claude-models.json`. Entries only drop after 2 consecutive
failed refreshes. If ids churn every run, the probes are timing out: lower
`CLAUDE_PROBE_CONCURRENCY` or raise `CLAUDE_PROBE_TIMEOUT_MS` in the proxy LaunchAgent.

### Probes report a valid model as invalid

The CLI's `stream-json` output can deliver its final `result` line **without a trailing
newline**. A reader that only parses on `\n` strands the verdict in its buffer and calls
a working model invalid, intermittently. `probe()` flushes its buffer on process close —
preserve that if you rewrite it. Only a definite `model_not_found`/404 is treated as
final; anything inconclusive is retried once.

## Proxy problems

| Symptom | Check |
|---|---|
| No response on :3457 | `cat /tmp/claude-proxy.err.log`; `launchctl list \| grep claude-proxy` |
| `[object Object]` in replies | you are still on `claude-max-api-proxy` — switch to `claude-proxy.js` |
| Answers from the wrong model | same cause: that proxy coerces unknown ids to opus |
| 502 `claude exited with code ...` | run the `claude --print` command by hand for the real error |
| 504 timeouts | raise `CLAUDE_PROXY_TIMEOUT_MS` (default 900000) |
| Requests queue up | raise `CLAUDE_PROXY_MAX_CONCURRENT` (default 4); each run is a CLI process |

Auth expiry looks like every model failing at once — see "Nothing works at all".

Port already in use: `lsof -nP -iTCP:3457 -sTCP:LISTEN`. Change `PORT` in the proxy
plist and `OPENCLAW_PROVIDER_BASE_URL` in the model-sync plist together, then re-sync.

## LaunchAgent problems

`Bootstrap failed: 5: Input/output error` means the previous job is still shutting down.
Loop until it is really gone, then bootstrap:

```bash
U=$(id -u); L=com.openclaw.claude-proxy
for i in $(seq 1 15); do launchctl print "gui/$U/$L" >/dev/null 2>&1 || break
  launchctl bootout "gui/$U/$L" 2>/dev/null; sleep 1; done
launchctl bootstrap "gui/$U" ~/Library/LaunchAgents/$L.plist
```

A non-zero exit in `launchctl list` output is the *last* exit status, not current state —
`-15` just means it was SIGTERMed once. Check the pid column and `/health` instead.

launchd jobs do not inherit your shell PATH; every plist here sets `PATH` explicitly.
Missing that is the usual cause of "works in my terminal, fails as a service".

## Config problems

```bash
openclaw config validate
openclaw config patch --file ./patch.json5 --dry-run
```

- `Refusing to replace ...; it would remove existing entries` — shrinking an array needs
  `--replace-path models.providers.claude-proxy.models` (repeatable per path).
- `Model override "x" is not allowed for agent "main"` — the id is missing from
  `agents.defaults.models`. Run model-sync; it maintains that allowlist and deletes
  entries for models that disappeared (via `null`).
- Never hand-edit `openclaw.json`; a bad edit takes the gateway down. Backups from setup
  are at `~/.openclaw/openclaw.json.pre-*`.

## Gateway "Internal Server Error" after an OpenClaw update

Updates can add channel plugins whose dependencies are not installed, and
`listBundledChannelPlugins` loads every channel plugin on every request — one missing
module fails all of them.

```bash
cd "$(npm root -g)/openclaw"
grep "Cannot find module" ~/.openclaw/logs/*.log \
  | sed "s/.*Cannot find module '\([^']*\)'.*/\1/" | sort -u
npm install @buape/carbon @larksuiteoapi/node-sdk @slack/web-api grammy
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway"
```

Repeat until `/health` returns `{"ok":true,"status":"live"}`. Commonly missing:
`@buape/carbon` (Discord), `@larksuiteoapi/node-sdk` (Feishu), `@slack/web-api` (Slack),
`grammy` (Telegram).

Note the CLI can auto-update underneath you — if behaviour changes mid-session, compare
`openclaw --version` and `claude --version` against what you started with. A Claude CLI
version change also forces a full model re-probe on the next refresh, which is intended.

## Billing verification

Note usage % at claude.ai/settings/billing, send traffic through OpenClaw, refresh. No
movement plus working responses suggests an API key is being used somewhere: check that
no `ANTHROPIC_API_KEY` is exported into the gateway's environment and that
`claude auth status` reports `"apiProvider": "firstParty"`.

## Diagnostic one-liners

```bash
launchctl list | grep -E 'openclaw|claude'
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3457|18789)'
curl -s http://127.0.0.1:3457/health | python3 -m json.tool
python3 -c "import json;d=json.load(open('$HOME/.openclaw/claude-models.json'));print(len(d['models']),[m['id'] for m in d['models']])"
tail -f /tmp/claude-proxy.err.log
openclaw logs
```
