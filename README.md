# Gantry — managed agents for the data platform

A bring-your-own-model reproduction of the [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)
console experience, built for a data-platform team whose agents triage
pipeline failures, run table QA, detect metric anomalies, and post PRs.

The platform's *shape* is kept — **agents, environments, sessions, events,
scheduled deployments, session tracing** — but the execution story is ours:

- **Bring your own model.** Provider API keys (Gemini first) live in
  Settings → Model providers. No Anthropic account required.
- **No hosted runtime.** Orchestration happens behind the scenes in an
  Airflow deployment on Kubernetes, inside the VPC, with access to
  Snowflake, S3, and GitHub. The console is a control plane only.
- **Simple harness, on purpose.** The agent loop is one non-interactive
  `gemini-cli` invocation per turn; gemini-cli runs its own tool loop.
  Upgrade path documented below.

```
┌────────────┐   /v1 REST + SSE   ┌───────────────────┐
│  Console   │ ◄────────────────► │   Control plane   │  agents, sessions,
│ (web/,SPA) │                    │    (server/)      │  events (JSONL),
└────────────┘                    └────────┬──────────┘  schedules, keys
                                           │ claim / post events
                              VPC          │
              ┌────────────────────────────┴─────────────┐
              │  Airflow on k8s (airflow/dags)           │
              │  ┌─────────────────────────────────────┐ │
              │  │ runner/gantry_runner.py → gemini-cli│ │
              │  │ creds: Snowflake · S3 · GitHub      │ │
              │  └─────────────────────────────────────┘ │
              └──────────────────────────────────────────┘
```

## Quickstart

```bash
# 1. Control plane (seeds a demo workspace on first boot, port 8081)
cd server && npm install && npm start

# 2. Console — either use the dev server…
cd web && npm install && npm run dev       # http://localhost:5173 (proxies /v1)

#    …or build once and let the control plane serve it:
cd web && npm install && npm run build     # then http://localhost:8081

# 3. A worker (what Airflow runs in production)
python3 runner/gantry_runner.py --once --dry-run   # exercise the loop
python3 runner/gantry_runner.py --poll 10          # real: needs `gemini` on PATH
```

Reset the demo workspace anytime with `cd server && npm run seed`.

## Concepts (mirroring the Managed Agents platform)

| Concept | In Gantry |
| --- | --- |
| **Agent** | Versioned config: name, model, system prompt, toolset, MCP connections. Updates bump `version` (stale writes 409); archive is terminal. |
| **Environment** | An Airflow/k8s deployment: cluster, namespace, network policy, mounted credentials, worker liveness. Always self-hosted. |
| **Session** | One agent run. Queued until a worker claims it; the full event history is an append-only JSONL log, streamed to the console over SSE. |
| **Events** | `{domain}.{action}` taxonomy: `user.message`, `user.interrupt`, `agent.message`, `agent.thinking`, `agent.tool_use/result`, `agent.mcp_tool_use/result`, `session.status_*`, `session.error`, `span.model_request_*`. |
| **Scheduled deployment** | Cron + IANA timezone; each firing writes a deployment run (success → `session_id`, failure → typed error) and unrecoverable config errors auto-pause the schedule. |

## API

The control plane mirrors the upstream surface where practical:

```
POST/GET  /v1/agents            POST /v1/agents/:id (versioned update, 409 on mismatch)
POST      /v1/agents/:id/archive     GET /v1/agents/:id/versions
POST/GET  /v1/environments      POST /v1/environments/:id/archive
POST/GET  /v1/sessions          GET  /v1/sessions/:id
POST/GET  /v1/sessions/:id/events    GET /v1/sessions/:id/stream   (SSE)
POST/GET  /v1/deployments       POST /v1/deployments/:id/{pause,unpause,archive,run}
GET       /v1/deployment_runs?deployment_id=&has_error=
GET       /v1/cron_preview?expression=&timezone=
GET/POST/DELETE /v1/provider_keys     (BYO model keys, masked on read)
GET       /v1/overview
```

Worker (internal) endpoints — used by the Airflow side, never the browser:

```
POST /v1/internal/claim                      → oldest queued session + agent config
                                               + full history + provider key
POST /v1/internal/sessions/:id/events        → agent.* / session.* / span.* events
GET  /v1/internal/sessions/:id               → poll session state (interrupts)
```

The public events endpoint accepts only `user.*` events; posting a
`user.message` to an idle session re-queues it for the next worker poll.
If a worker dies after claiming, the stale-claim sweeper re-queues any
running session with no events for `GANTRY_SESSION_LEASE_MINUTES`
(default 45).

## Security model

- The console/control plane stores **only** model-provider keys. Warehouse
  and platform credentials (Snowflake, S3, GitHub) are mounted into the
  Airflow pods from k8s secrets — the browser never sees them.
- The provider key is handed to a worker only when it claims a session.
- Environments are `vpc_only`: the agent's tools reach internal systems,
  not the public internet, unless the environment says otherwise.

## The harness (and its upgrade path)

`runner/gantry_runner.py` flattens the session history into one prompt,
runs `gemini --prompt … --yolo --output-format json`, and posts back
`agent.message` + token usage + `session.status_idle` (or `session.error`
+ `session.status_terminated`). That's it by design.

Already handled beyond the single-shot loop:

- **Interrupts** — the runner polls the control plane while gemini runs and
  kills the process when the console sends `user.interrupt`
  (`stop_reason: "interrupted"`).
- **Claim fencing** — every claim issues a rotating `claim_token`; posts
  with a stale token get 409, so a worker that lost its lease can't corrupt
  a re-claimed session. The stale-claim sweeper rotates the token when it
  re-queues a dead worker's session.
- **Missed steering** — a user message that lands mid-run re-queues the
  session when the worker reports idle, so it is never silently dropped.

When it's time to grow up further, the seams are in place:

1. **Streamed tool events** — parse gemini-cli's stream-json output and emit
   real `agent.tool_use`/`agent.tool_result` events instead of one final message.
2. **Real MCP** — attach the agent's `mcp_servers` to gemini-cli's MCP config
   instead of shelling out to CLIs.
3. **Different harnesses per provider** — the claim bundle carries
   `agent.model.provider`; route to a Claude/OpenAI harness when keys exist.

Run the control-plane test suite (cron engine regressions incl. DST, the
full session/claim/deployment lifecycle) with `cd server && npm test`.

## Repository layout

```
server/    control plane (Express, JSON + JSONL storage, cron scheduler, seed)
web/       console SPA (Vite + React, no UI framework — see docs/DESIGN.md)
runner/    gemini-cli worker + Dockerfile
airflow/   example worker DAG (KubernetesPodOperator + lightweight variant)
docs/      research notes and the design system
```

Branding note: per the upstream branding guidelines this project uses its
own name and mark and does not present itself as an Anthropic product.
