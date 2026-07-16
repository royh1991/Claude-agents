# Gantry — a managed agent console for the data platform

Gantry is a bring-your-own-model reproduction of the Claude Managed Agents
console experience. It keeps the platform's *shape* — agents, environments,
sessions, events, scheduled deployments — and swaps the execution story:
orchestration runs in our Airflow/Kubernetes deployment (inside the VPC, with
Snowflake/S3/GitHub credentials), and the agent loop is a plain `gemini-cli`
invocation the runner drives.

Per Anthropic's Managed Agents branding guidelines, this product carries its
own brand ("Gantry") and does not present itself as Claude Code or any
Anthropic product.

## 1. Research summary (what we are reproducing)

Sources: the engineering blog "Scaling Managed Agents: decoupling the brain
from the hands", the Claude Platform docs (overview, quickstart, agent-setup,
scheduled-deployments, reference), and launch coverage.

### Core concepts (verbatim from the platform)

| Concept | Description |
| --- | --- |
| **Agent** | The model, system prompt, tools, MCP servers, and skills. Versioned; referenced by ID across sessions. |
| **Environment** | Where sessions run: a managed cloud sandbox or a *self-hosted* sandbox on your own infrastructure. |
| **Session** | A running agent instance in an environment, performing a task and generating outputs. An append-only log of everything that happened. |
| **Events** | Messages exchanged between application and agent (user turns, tool results, status updates). |
| **Scheduled deployment** | An agent that starts sessions autonomously on a cron schedule; each attempt is a *deployment run* with success/error recorded. |

### Event taxonomy (`{domain}.{action}`)

- **User:** `user.message`, `user.interrupt`, `user.tool_confirmation`, `user.custom_tool_result`
- **Agent:** `agent.message`, `agent.thinking`, `agent.tool_use`, `agent.tool_result`,
  `agent.mcp_tool_use`, `agent.mcp_tool_result`, `agent.thread_context_compacted`
- **Session:** `session.status_running`, `session.status_idle` (with `stop_reason`),
  `session.status_rescheduled`, `session.status_terminated`, `session.error`, `session.updated`
- **Span (observability):** `span.model_request_start`, `span.model_request_end` (carries `model_usage` token counts)

### Behaviors we mirror

- Agents are **versioned**: updates bump `version`, stale-version writes 409, archive is terminal/read-only.
- Deployments: POSIX cron + IANA timezone, `upcoming_runs_at` preview, pause / unpause / archive,
  manual `run` endpoint, and a **deployment run** record per trigger with typed errors
  (`environment_archived_error`, `agent_archived_error`, `session_rate_limited_error`).
- Sessions stream events over SSE; history is persisted server-side and can be fetched in full.
- Console features called out at launch: **session tracing** ("inspect every tool call,
  decision, and failure mode"), integration analytics, troubleshooting.

### Deliberate divergences

| Anthropic platform | Gantry |
| --- | --- |
| Anthropic-hosted harness + cloud sandboxes | No runtime here. Airflow on k8s claims queued sessions and runs them in-VPC. |
| Claude models | **Bring your own model.** Provider API keys stored in Settings; models are provider-namespaced (Gemini first, since the harness is `gemini-cli`). |
| Rich harness (compaction, permissions, steering) | Simple harness: runner sends the prompt to `gemini-cli`, which runs its own loop. Upgrade path documented. |
| Cloud + self-hosted environments | Self-hosted only. An environment models an Airflow deployment: cluster, namespace, network policy, and which credentials (Snowflake, S3, GitHub) its pods mount. |

The self-hosted worker model is the load-bearing idea we keep: like
`ant beta:worker`, our runner polls the control plane for queued sessions
(`POST /v1/internal/claim`), executes, and posts events back. The console never
touches credentials — Airflow owns them.

## 2. Design plan (frontend-design skill process)

**Subject:** an internal console where data-platform engineers watch a fleet of
agents that triage pipeline failures, QA warehouse tables, detect anomalies,
and post PRs. **Audience:** platform/data engineers on call. **The page's
job:** "what did my agents do overnight, and is anything wrong?"

**The brief pins the visual direction** — mimic the Claude Console — so the
token system is executed to match it, precisely, rather than invented:

### Tokens

- **Color** — `--paper #FAF9F5` (page), `--panel #FFFFFF`, `--ink #1F1E1D`,
  `--ink-2 #6B6A64` (secondary), `--line #E5E2D9` (hairlines), `--clay #C15F3C`
  (accent: links, primary buttons, running pulse), `--clay-soft #F5E8E0`.
  Status (reserved, icon + label, never color alone): good `#3D7A37`,
  warning `#976F0C`, serious `#B42318`, neutral `#6B6A64`.
  Chart marks are single-hue clay; palette validated with the dataviz
  validator against both surfaces.
- **Type** — display serif for page titles and hero numbers:
  `Copernicus, "Tiempos Headline", Georgia, serif`; UI sans:
  `"Styrene B", ui-sans-serif, -apple-system, "Segoe UI", sans-serif`;
  data/IDs/events in `ui-monospace, "SF Mono", Menlo, monospace`. Local stacks
  only — no font downloads, graceful fallback.
- **Layout** — fixed 232px left nav on paper, content column max 1120px,
  white cards with 1px warm hairlines and 10px radius, generous 24/32 spacing.
  Tables are hairline-ruled, never zebra-striped.

```
┌──────────┬──────────────────────────────────────────┐
│ Gantry   │  Overview                    [Create ▾]  │
│          │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐         │
│ Overview │  │tile │ │tile │ │tile │ │tile │         │
│ Agents   │  └─────┘ └─────┘ └─────┘ └─────┘         │
│ Sessions │  Sessions this week ▂▄▆▃▇ (single hue)   │
│ Environ. │  ┌──────────────────────────────────────┐│
│ Schedules│  │ recent sessions table                ││
│ Settings │  └──────────────────────────────────────┘│
└──────────┴──────────────────────────────────────────┘
```

### Signature element

The **session trace rail**: every session detail page is a vertical,
append-only timeline where each event hangs off a hairline spine with a typed
glyph — user turns right-set on clay-tinted paper, agent prose on white, tool
calls as collapsible mono cards showing input/output, span events as quiet
token-count ticks, and a breathing clay pulse at the foot of any running
session. It is the product's whole argument (the append-only log made
visible), so everything around it stays quiet.

**Self-critique against the generic default:** cream + serif + terracotta is
normally the templated answer; here it is the brief. The risk budget is spent
on the trace rail, not on decoration. Removed before building: numbered
section markers (no true sequence), gradient hero, dark-mode toggle
(out of scope), zebra tables, and any second accent hue.

### Copy rules

Sentence case; verbs name outcomes ("Create agent", "Run now", "Pause
schedule"); statuses are plain words ("Running", "Idle", "Terminated");
errors say what happened and what to do next; empty states invite the first
action. IDs are always visible and copyable — this is a console for engineers.

## 3. Page inventory

1. **Overview** — 4 stat tiles (active sessions, runs today, success rate 7d,
   session-hours 7d), single-series sessions-per-day bar chart, recent
   sessions, next scheduled runs.
2. **Agents** — table (name, model, version, tools, updated). Detail: config,
   version history, recent sessions. Create/edit form: name, description,
   provider+model, system prompt, toolset + MCP connections (Snowflake, S3,
   GitHub, dbt), permission policy.
3. **Sessions** — filterable table (status, agent). Detail: the trace rail +
   composer (send `user.message`, interrupt) + metadata sidebar (agent@version,
   environment, deployment run, token usage rollup).
4. **Environments** — Airflow/k8s targets: cluster, namespace, network policy,
   mounted credentials (masked), worker liveness.
5. **Schedules** — deployments table (cron, tz, next runs, status) with
   pause/unpause/run-now; detail shows deployment run history with typed errors.
6. **Settings → Model providers** — BYO API keys (Gemini live; Anthropic/OpenAI
   slots), masked at rest, delete/rotate.
