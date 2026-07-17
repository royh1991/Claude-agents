# Gantry — agent console for the Credible BI AI runtime

The no-code frontend for `credible-bi-airflow-triage`: a console where
non-technical users create and manage YAML-defined agents, trigger runs, and
read structured results — styled after the Claude Managed Agents console.

The backend owns execution and is **not in this repo**. Its contract (the
backend CLAUDE.md) is the source of truth; this console is a client of it.

## The non-negotiables this console is built around

1. **Airflow is the orchestrator.** Every run is a dag run of
   `ai-agent-runner`. The console triggers runs only by submitting a
   session envelope as `dag_run.conf` through the Airflow REST API — there
   is no agent-executing service here.
2. **Airflow runs on Kubernetes, inside the VPC.** The console displays the
   environment; it never touches k8s or the warehouse.
3. **Secrets live in Vault.** The console stores no credentials and shows
   none. The only secret this server can hold is an Airflow API credential,
   server-side, for proxying run requests.
4. **Agents are YAML.** The builder reads the backend's catalogs
   (`agents/`, `skills/`, `tools/`, `response_formats/`, `environments/`)
   and publishing writes exactly one file: `agents/<id>/agent.yaml` (or
   `agent_triggers/<id>.yaml`). No commits, no deploys, no Python — a PR in
   the backend repo ships it.

```
 browser ──► console server (this repo) ──► backend checkout (YAML catalogs)
                    │                          agents/  skills/  tools/
                    │                          response_formats/  environments/
                    └────────────────────► Airflow REST API
                                            POST dagRuns (session envelope)
                                            GET  dagRuns / taskInstances / XCom result
```

## Running it

```bash
# Console server (port 8081) — serves the API and the built SPA
cd server && npm install && npm start

# Frontend dev server (optional, hot reload)
cd web && npm install && npm run dev        # http://localhost:5173

# Production: build once, the console server serves it
cd web && npm run build                     # then http://localhost:8081
```

Configuration (all optional — sensible dev defaults):

| Env var | Meaning | Default |
| --- | --- | --- |
| `BACKEND_REPO_ROOT` | Path to a `credible-bi-airflow-triage` checkout | bundled `backend-fixture/` |
| `BACKEND_PACKAGE_DIR` | Package dir inside that repo | `dags/credible_bi_airflow_triage` |
| `AIRFLOW_BASE_URL` | Airflow webserver URL; unset = **mock run mode** | unset |
| `AIRFLOW_API_VERSION` | `v2` (Airflow 3, JWT), `v1` (Airflow 2, basic), or auto-probe | auto |
| `AIRFLOW_USERNAME` / `AIRFLOW_PASSWORD` | v1: basic auth; v2: exchanged for a JWT at `/auth/token` | — |
| `AIRFLOW_TOKEN` | Pre-minted bearer/JWT alternative | — |
| `AIRFLOW_DAG_ID` | The runner DAG id | `ai-agent-runner` |

Without `AIRFLOW_BASE_URL` the console simulates runs (same task graph,
same result envelopes, schema-valid mock outputs) so the full experience
works locally. Without `BACKEND_REPO_ROOT` it reads `backend-fixture/`, a
dev replica of the backend package's catalog files.

## What each page maps to in the backend

| Page | Backend concept |
| --- | --- |
| **Agents** | `agents/<id>/agent.yaml` packs (name, model, system prompt, tools, skills, response format, metadata) |
| **Agent builder** | Generates canonical `agent.yaml`; validation mirrors `normalize_yaml_agent_config` (id regex, known tools/skills/formats, schema subset); publish = file write + PR guidance |
| **Run composer** | Builds a §4.1 **session envelope** (`type: session`, `agent`, `events[0].user.message`, `resources`, `metadata`, `response_format`) |
| **Runs** | `ai-agent-runner` dag runs; the task pipeline (build-request → run-agent → evaluate-result → post-notifications) with the run-agent XCom rendered as the result |
| **Run result** | The §10 result envelope; `result.result` rendered schema-driven from the response format; statuses `success / invalid_input / resource_error / provider_error / invalid_output / runtime_error` |
| **Triggers** | Declarative `agent_triggers/<id>.yaml` (`schema_version: 2`, a **proposal** pending `managed_agent_frontend.md`). Fire kinds mirror real Airflow orchestration: `dag_complete` (all_done + content conditions, because dbt task state can lie), `asset_updated` (Airflow 3 Assets via one generic router DAG), `schedule` (one generic scheduler), `manual`. `only_if` conditions (e.g. `dbt_failed_nodes`) are evaluated from run artifacts, not task state |
| **Library** | `skills/*.md`, `tools/*.yaml`, `response_formats/*.yaml` read-only browsers |
| **Environment** | `environments/airflow-triage-runtime.yaml` + shared guardrails |

Key backend behaviors the console reproduces faithfully:

- A run can be **green at `run-agent` and red at `evaluate-result`** — the
  runtime emits a structured non-success result and Airflow turns it red.
  The run page explains this instead of hiding it.
- `agent.version` in a request must match the checked-in version; the
  console pins the current version when composing runs.
- Response format schemas stay inside the runtime's JSON-schema subset
  (no `$ref` / `oneOf` / `pattern`); the builder rejects anything outside it.
- Requests must stay under 60 kB (they travel to the pod as an env var).

## Non-goals (enforced, not just documented)

- No secrets in the browser or in this server's storage.
- No Python/DAG generation — triggers are declarative YAML only.
- No git operations — publishing writes files; humans review and merge.
- No writes outside `agents/<id>/agent.yaml` and `agent_triggers/<id>.yaml`
  (id-regex + path-containment guarded, with overwrite confirmation).

## Development

```bash
cd server && npm test      # catalog/validation/publish/envelope/mock-run suite + cron engine
```

`docs/DESIGN.md` covers the visual system (unchanged by the pivot) and the
project's history: this console began as a BYO-model reproduction of the
Claude Managed Agents platform, then was re-pointed at the real backend
contract. Per that platform's branding guidelines, this product uses its own
name and does not present itself as an Anthropic product.
