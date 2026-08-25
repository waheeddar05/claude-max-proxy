# skills

A collection of Claude/Cowork **skills**. Each skill lives in its own folder
with a `SKILL.md` (name + description + instructions) plus any `references/`,
`templates/`, and `scripts/` it needs.

## Skills

### [`gke-service-deploy/`](./gke-service-deploy/)
Deploy a Saras Analytics service to the GKE clusters (dev, test/QA, prod) from
its GitHub repo using the build-once + ArgoCD + Kargo artifact-promotion
pattern. Pass a GitHub repo URL and it deploys (or promotes) the service —
per-env Cloud SQL DBs, secrets, Helm values, ArgoCD apps, ingress/DNS, Kargo
stages, and the active/passive toggle for side-effecting services. Encodes the
real infra facts and the failure modes learned standing up `autoship`.

### [`openclaw-max-proxy/`](./openclaw-max-proxy/)
Route OpenClaw through a Claude Max/Pro/Team subscription by driving the Claude
Code CLI behind a self-contained OpenAI-compatible proxy, so traffic bills
against the subscription instead of API credits. The model catalog is
discovered live from the CLI — mined from the installed bundle *and* probed one
to two releases ahead — so a model released server-side with no CLI update
still shows up on its own. Ships the proxy, the discovery and config-sync jobs,
and an idempotent installer. _(Renamed from `claude-max-proxy/`; git history is
preserved. The third-party `claude-max-api-proxy` it used to wrap is retired —
it hardcoded three model ids and silently coerced unknown models to opus.)_

## Using a skill

Install a skill into Cowork/Claude via **Settings → Capabilities** (point it at
the skill folder, or install a packaged `.skill` bundle). A skill is just a
folder of instructions — Claude reads `SKILL.md` when the task matches its
description and follows it.
