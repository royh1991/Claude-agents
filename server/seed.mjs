// Demo workspace: agents, environments, sessions with full traces,
// scheduled deployments and their run history. Everything is generated
// relative to "now" so the console always looks alive.
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './lib/store.mjs';
import { nextRun } from './lib/cron.mjs';
import {
  newAgentId, newEnvironmentId, newSessionId,
  newDeploymentId, newDeploymentRunId, newKeyId, newEventId,
} from './lib/ids.mjs';

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

export function seed(store) {
  // ------------------------------------------------------------ agents
  const triage = {
    id: newAgentId(), type: 'agent',
    name: 'Pipeline triage',
    description: 'Diagnoses failed Airflow DAG runs: reads task logs, checks Snowflake query history, and files issues with a root-cause writeup.',
    model: { id: 'gemini-2.5-pro', provider: 'google' },
    system: 'You are an on-call data platform engineer. When a DAG run fails, find the failing task, read its logs, and trace the root cause through Snowflake query history and the source files on S3. Separate root cause from symptoms. If the cause is upstream data, open a GitHub issue on data-platform/warehouse with the evidence. Keep the writeup short: what broke, why, blast radius, suggested fix.',
    tools: [
      { type: 'agent_toolset', config: { bash: true, file_operations: true, web_search: false } },
    ],
    mcp_servers: [
      { name: 'snowflake', url: 'https://mcp.internal/snowflake', tools: ['query', 'query_history'] },
      { name: 's3', url: 'https://mcp.internal/s3', tools: ['get_object', 'list_objects'] },
      { name: 'github', url: 'https://mcp.internal/github', tools: ['create_issue', 'create_pull_request'] },
    ],
    skills: [],
    metadata: { team: 'data-platform', pager: 'data-oncall' },
    version: 3,
    created_at: iso(31 * DAY), updated_at: iso(6 * DAY), archived_at: null,
  };

  const qa = {
    id: newAgentId(), type: 'agent',
    name: 'Table QA sentinel',
    description: 'Runs daily quality checks on warehouse tables: freshness, row counts, null rates, schema drift. Files an issue when a check regresses.',
    model: { id: 'gemini-2.5-flash', provider: 'google' },
    system: 'You run data quality checks against the analytics warehouse. For each table in the check manifest, verify freshness, row-count deltas vs the 28-day median, null rates on key columns, and schema drift. Summarize results as a table: check, status, observed, threshold. Open a GitHub issue for any regression, one issue per table, and link the failing query.',
    tools: [{ type: 'agent_toolset', config: { bash: true, file_operations: true, web_search: false } }],
    mcp_servers: [
      { name: 'snowflake', url: 'https://mcp.internal/snowflake', tools: ['query'] },
      { name: 'github', url: 'https://mcp.internal/github', tools: ['create_issue'] },
    ],
    skills: [],
    metadata: { team: 'analytics-eng' },
    version: 1,
    created_at: iso(24 * DAY), updated_at: iso(24 * DAY), archived_at: null,
  };

  const anomaly = {
    id: newAgentId(), type: 'agent',
    name: 'Anomaly detector',
    description: 'Scans core business metrics for anomalies against seasonal baselines and explains what moved.',
    model: { id: 'gemini-2.5-pro', provider: 'google' },
    system: 'You scan daily aggregates of core revenue and engagement metrics. Compare each series against a 28-day seasonal baseline; flag |z| >= 3. For each flag, drill one level down (region, platform, product line) to locate the driver before reporting. Report only anomalies with a located driver or an explicit "driver unknown".',
    tools: [{ type: 'agent_toolset', config: { bash: true, file_operations: true, web_search: false } }],
    mcp_servers: [
      { name: 'snowflake', url: 'https://mcp.internal/snowflake', tools: ['query'] },
      { name: 's3', url: 'https://mcp.internal/s3', tools: ['get_object'] },
    ],
    skills: [],
    metadata: { team: 'data-platform' },
    version: 2,
    created_at: iso(19 * DAY), updated_at: iso(3 * DAY), archived_at: null,
  };

  const prFixer = {
    id: newAgentId(), type: 'agent',
    name: 'dbt PR fixer',
    description: 'Reproduces failing dbt tests, writes the fix, and opens a pull request with the diff and test evidence.',
    model: { id: 'gemini-2.5-pro', provider: 'google' },
    system: 'You fix failing dbt tests in data-platform/warehouse. Clone the repo, reproduce the failure, and make the smallest change that fixes the test without changing intended semantics. Run the affected tests before opening a PR. The PR body must show the failing output, the diff rationale, and the passing run.',
    tools: [{ type: 'agent_toolset', config: { bash: true, file_operations: true, web_search: false } }],
    mcp_servers: [
      { name: 'github', url: 'https://mcp.internal/github', tools: ['create_pull_request'] },
      { name: 'snowflake', url: 'https://mcp.internal/snowflake', tools: ['query'] },
    ],
    skills: [],
    metadata: { team: 'analytics-eng' },
    version: 1,
    created_at: iso(12 * DAY), updated_at: iso(12 * DAY), archived_at: null,
  };

  for (const agent of [triage, qa, anomaly, prFixer]) store.insert('agents', agent);

  // Version history for the two agents that have evolved.
  store.insert('agent_versions', { ...triage, version: 1, system: 'You are an on-call data platform engineer. Diagnose failed Airflow DAG runs and report the root cause.', mcp_servers: triage.mcp_servers.slice(0, 2), updated_at: iso(31 * DAY) });
  store.insert('agent_versions', { ...triage, version: 2, updated_at: iso(14 * DAY) });
  store.insert('agent_versions', { ...triage });
  store.insert('agent_versions', { ...qa });
  store.insert('agent_versions', { ...anomaly, version: 1, updated_at: iso(19 * DAY) });
  store.insert('agent_versions', { ...anomaly });
  store.insert('agent_versions', { ...prFixer });

  // ------------------------------------------------------ environments
  const prod = store.insert('environments', {
    id: newEnvironmentId(), type: 'environment',
    name: 'airflow-prod',
    config: {
      type: 'self_hosted',
      cluster: 'eks-data-prod',
      namespace: 'data-agents',
      network_policy: 'vpc_only',
      credentials: [
        { name: 'SNOWFLAKE_SVC_AGENTS', type: 'snowflake', detail: 'role AGENT_RO, warehouse WH_AGENTS_XS' },
        { name: 'AWS_ROLE_DATA_LAKE_RO', type: 's3', detail: 'read: df-data-lake, df-airflow-logs' },
        { name: 'GITHUB_APP_DATA_BOT', type: 'github', detail: 'repo scope: data-platform/*' },
      ],
    },
    worker: { status: 'online', last_seen_at: iso(2 * MIN), worker_id: 'airflow-prod-worker-7f4c9' },
    created_at: iso(31 * DAY), archived_at: null,
  });

  const staging = store.insert('environments', {
    id: newEnvironmentId(), type: 'environment',
    name: 'airflow-staging',
    config: {
      type: 'self_hosted',
      cluster: 'eks-data-staging',
      namespace: 'data-agents',
      network_policy: 'vpc_only',
      credentials: [
        { name: 'SNOWFLAKE_SVC_AGENTS_STG', type: 'snowflake', detail: 'role AGENT_RO, warehouse WH_DEV_XS' },
      ],
    },
    worker: { status: 'offline', last_seen_at: iso(3 * DAY), worker_id: 'airflow-stg-worker-b21aa' },
    created_at: iso(28 * DAY), archived_at: null,
  });

  // --------------------------------------------------------- sessions
  const sessions = [];
  function addSession({ agent, env, title, status, startedAgo, events, stopReason = null, deploymentRunId = null, lastError = null }) {
    const sessionId = newSessionId();
    let usage = { input_tokens: 0, output_tokens: 0 };
    let lastAt = iso(startedAgo);
    for (const [offsetMs, event] of events) {
      const createdAt = iso(startedAgo - offsetMs);
      lastAt = createdAt;
      if (event.type === 'span.model_request_end' && event.model_usage) {
        usage = {
          input_tokens: usage.input_tokens + event.model_usage.input_tokens,
          output_tokens: usage.output_tokens + event.model_usage.output_tokens,
        };
      }
      store.appendEvent(sessionId, { ...event, id: newEventId(), created_at: createdAt });
    }
    const session = store.insert('sessions', {
      id: sessionId, type: 'session',
      agent: { id: agent.id, version: agent.version },
      environment_id: env.id,
      title, status,
      stop_reason: stopReason,
      interrupt_requested: false,
      usage,
      deployment_run_id: deploymentRunId,
      last_error: lastError,
      created_at: iso(startedAgo),
      updated_at: lastAt,
      last_event_at: lastAt,
    });
    sessions.push(session);
    return session;
  }

  // Flagship trace: pipeline triage, finished this morning.
  const s1 = addSession({
    agent: triage, env: prod,
    title: 'Triage: dw_core_load failed at load_fct_orders',
    status: 'idle', stopReason: 'end_turn', startedAgo: 5 * HOUR,
    events: [
      [0, { type: 'user.message', content: [{ type: 'text', text: 'Diagnose the failure of DAG dw_core_load, run 2026-07-16T06:00Z (failing task: load_fct_orders, attempt 2). Post findings here; open a GitHub issue if the root cause is upstream data.' }] }],
      [2000, { type: 'session.status_running', worker_id: 'airflow-prod-worker-7f4c9' }],
      [4000, { type: 'span.model_request_start', model: 'gemini-2.5-pro' }],
      [9000, { type: 'agent.thinking', content: [{ type: 'text', text: 'The task name suggests a COPY INTO or MERGE into fct_orders. First step is the task log for attempt 2, then the Snowflake query history around the failure timestamp.' }] }],
      [15000, { type: 'agent.tool_use', name: 'bash', input: { command: "aws s3 cp 's3://df-airflow-logs/dw_core_load/2026-07-16T06:00/load_fct_orders/attempt=2.log' - | tail -n 40" } }],
      [21000, { type: 'agent.tool_result', tool: 'bash', output: "[2026-07-16 06:14:02] INFO  Executing COPY INTO analytics.fct_orders_stage FROM @raw.orders_landing/2026-07-16/\n[2026-07-16 06:14:09] ERROR snowflake.connector 100038 (22018): Numeric value 'N/A' is not recognized in column AMOUNT, file orders_2026-07-16_part-0007.csv.gz, line 18422\n[2026-07-16 06:14:09] ERROR Task failed with exception" }],
      [30000, { type: 'agent.mcp_tool_use', server: 'snowflake', name: 'query', input: { sql: "SELECT COUNT(*) AS bad_rows, MIN(filename) AS first_file FROM @raw.orders_landing/2026-07-16/ (FILE_FORMAT => raw.csv_gz) WHERE TRY_TO_NUMBER($7) IS NULL AND $7 IS NOT NULL AND $7 <> ''" } }],
      [41000, { type: 'agent.mcp_tool_result', server: 'snowflake', output: { rows: [{ BAD_ROWS: 412, FIRST_FILE: 'orders_2026-07-16_part-0007.csv.gz' }], elapsed_ms: 3120 } }],
      [52000, { type: 'agent.mcp_tool_use', server: 'snowflake', name: 'query_history', input: { filter: "query_text ILIKE '%orders_landing%' AND start_time >= '2026-07-15'", limit: 5 } }],
      [60000, { type: 'agent.mcp_tool_result', server: 'snowflake', output: { rows: [{ QUERY_ID: '01b7-9f2e', STATUS: 'FAILED', ERROR_CODE: 100038, START_TIME: '2026-07-16 06:14:03' }, { QUERY_ID: '01b7-88c1', STATUS: 'SUCCESS', START_TIME: '2026-07-15 06:13:44' }], elapsed_ms: 890 } }],
      [70000, { type: 'agent.thinking', content: [{ type: 'text', text: "Yesterday's load succeeded, today's file has 412 rows with amount = 'N/A'. This is an upstream export regression in the orders service, not a warehouse problem. File the issue with evidence and suggest a TRY_TO_NUMBER guard as mitigation." }] }],
      [82000, { type: 'agent.mcp_tool_use', server: 'github', name: 'create_issue', input: { repo: 'data-platform/warehouse', title: "orders export 2026-07-16 ships 'N/A' in amount — dw_core_load blocked", labels: ['data-quality', 'upstream'] } }],
      [90000, { type: 'agent.mcp_tool_result', server: 'github', output: { number: 482, url: 'https://github.com/data-platform/warehouse/issues/482' } }],
      [104000, { type: 'agent.message', content: [{ type: 'text', text: "**Root cause:** today's orders export (part-0007, 412 rows) contains the literal string `N/A` in `amount`; `COPY INTO fct_orders_stage` fails with Snowflake error 100038. Yesterday's load on the same pipeline succeeded, so this is an upstream regression in the orders service export, not a warehouse change.\n\n**Blast radius:** fct_orders and 6 downstream marts are stale since 06:14 UTC. No partial load — the COPY aborted before commit.\n\n**Actions:** opened [data-platform/warehouse#482](https://github.com/data-platform/warehouse/issues/482) with the failing file and row sample. Suggested mitigation until the export is fixed: stage with `TRY_TO_NUMBER(amount)` + reject table, so one bad partition can't block the whole load." }] }],
      [106000, { type: 'span.model_request_end', model: 'gemini-2.5-pro', model_usage: { input_tokens: 48211, output_tokens: 2934 } }],
      [107000, { type: 'session.status_idle', stop_reason: 'end_turn' }],
    ],
  });

  // Table QA with one regression.
  const s2 = addSession({
    agent: qa, env: prod,
    title: 'Nightly QA sweep — core marts',
    status: 'idle', stopReason: 'end_turn', startedAgo: 11 * HOUR,
    events: [
      [0, { type: 'user.message', content: [{ type: 'text', text: 'Run the nightly quality checks for the core mart tables (manifest: qa/core_marts.yml).' }] }],
      [1500, { type: 'session.status_running', worker_id: 'airflow-prod-worker-7f4c9' }],
      [8000, { type: 'agent.mcp_tool_use', server: 'snowflake', name: 'query', input: { sql: 'SELECT table_name, MAX(loaded_at) AS last_load, COUNT(*) AS row_count FROM analytics.information_schema… (24 checks batched)' } }],
      [26000, { type: 'agent.mcp_tool_result', server: 'snowflake', output: { rows: 24, elapsed_ms: 14210 } }],
      [40000, { type: 'agent.mcp_tool_use', server: 'github', name: 'create_issue', input: { repo: 'data-platform/warehouse', title: 'fct_orders.discount_code null rate 7.4% (threshold 1%)', labels: ['data-quality'] } }],
      [46000, { type: 'agent.mcp_tool_result', server: 'github', output: { number: 479, url: 'https://github.com/data-platform/warehouse/issues/479' } }],
      [58000, { type: 'agent.message', content: [{ type: 'text', text: '23 of 24 checks passed.\n\n| check | status | observed | threshold |\n| --- | --- | --- | --- |\n| fct_orders freshness | pass | 05:12 UTC | < 07:00 |\n| fct_orders row delta | pass | +1.8% | ±15% |\n| **fct_orders.discount_code null rate** | **fail** | **7.4%** | **< 1%** |\n| dim_customers schema | pass | no drift | — |\n\nThe null-rate regression started 2026-07-14 and coincides with checkout release v214. Filed [warehouse#479](https://github.com/data-platform/warehouse/issues/479).' }] }],
      [60000, { type: 'span.model_request_end', model: 'gemini-2.5-flash', model_usage: { input_tokens: 21870, output_tokens: 1411 } }],
      [61000, { type: 'session.status_idle', stop_reason: 'end_turn' }],
    ],
  });

  // Live running session (the pulse).
  addSession({
    agent: anomaly, env: prod,
    title: 'Daily anomaly scan — revenue metrics',
    status: 'running', startedAgo: 9 * MIN,
    events: [
      [0, { type: 'user.message', content: [{ type: 'text', text: 'Run the daily anomaly scan on core revenue metrics for 2026-07-15 (UTC close).' }] }],
      [1200, { type: 'session.status_running', worker_id: 'airflow-prod-worker-7f4c9' }],
      [4000, { type: 'span.model_request_start', model: 'gemini-2.5-pro' }],
      [7000, { type: 'agent.thinking', content: [{ type: 'text', text: 'Pull 35 days of daily aggregates per metric so the 28-day baseline has a buffer, then z-score yesterday against the same weekday.' }] }],
      [12000, { type: 'agent.mcp_tool_use', server: 'snowflake', name: 'query', input: { sql: "SELECT metric, ds, value FROM analytics.metric_daily WHERE ds >= DATEADD('day', -35, '2026-07-15') AND metric IN ('gross_revenue','net_revenue','orders','aov','refund_rate')" } }],
      [3 * MIN, { type: 'agent.mcp_tool_result', server: 'snowflake', output: { rows: 175, elapsed_ms: 6480 } }],
      [4 * MIN, { type: 'agent.thinking', content: [{ type: 'text', text: 'refund_rate for 2026-07-15 is z = 3.6 vs weekday baseline. Drilling into region × platform to find the driver before flagging.' }] }],
      [5 * MIN, { type: 'agent.mcp_tool_use', server: 'snowflake', name: 'query', input: { sql: "SELECT region, platform, refund_rate FROM analytics.metric_daily_dims WHERE ds = '2026-07-15' ORDER BY refund_rate DESC LIMIT 20" } }],
    ],
  });

  // PR fixer success.
  const s4 = addSession({
    agent: prFixer, env: prod,
    title: 'Fix failing dbt test: unique_dim_customers_customer_id',
    status: 'idle', stopReason: 'end_turn', startedAgo: 28 * HOUR,
    events: [
      [0, { type: 'user.message', content: [{ type: 'text', text: 'dbt test unique_dim_customers_customer_id has been failing since the 2026-07-14 run. Reproduce, fix, and open a PR.' }] }],
      [2000, { type: 'session.status_running', worker_id: 'airflow-prod-worker-7f4c9' }],
      [10000, { type: 'agent.tool_use', name: 'bash', input: { command: 'git clone --depth 1 git@github.com:data-platform/warehouse.git && cd warehouse && dbt test --select unique_dim_customers_customer_id' } }],
      [55000, { type: 'agent.tool_result', tool: 'bash', output: 'FAIL 1 unique_dim_customers_customer_id — 12 duplicate customer_id values\nDone. PASS=0 WARN=0 ERROR=1' } ],
      [80000, { type: 'agent.mcp_tool_use', server: 'snowflake', name: 'query', input: { sql: 'SELECT customer_id, COUNT(*) c FROM analytics.dim_customers GROUP BY 1 HAVING c > 1 LIMIT 20' } }],
      [95000, { type: 'agent.mcp_tool_result', server: 'snowflake', output: { rows: 12, note: 'all duplicates have source = "shopify_v2" and differ only in loaded_at' } }],
      [120000, { type: 'agent.tool_use', name: 'edit', input: { path: 'models/marts/dim_customers.sql', summary: 'dedupe shopify_v2 source on customer_id keeping latest loaded_at (qualify row_number)' } }],
      [125000, { type: 'agent.tool_result', tool: 'edit', output: 'models/marts/dim_customers.sql updated (+4 -1)' }],
      [180000, { type: 'agent.tool_use', name: 'bash', input: { command: 'dbt test --select unique_dim_customers_customer_id' } }],
      [230000, { type: 'agent.tool_result', tool: 'bash', output: 'PASS 1 unique_dim_customers_customer_id\nDone. PASS=1 WARN=0 ERROR=0' }],
      [250000, { type: 'agent.mcp_tool_use', server: 'github', name: 'create_pull_request', input: { repo: 'data-platform/warehouse', title: 'dim_customers: dedupe shopify_v2 rows on customer_id', head: 'agents/fix-dim-customers-unique' } }],
      [258000, { type: 'agent.mcp_tool_result', server: 'github', output: { number: 1187, url: 'https://github.com/data-platform/warehouse/pull/1187' } }],
      [270000, { type: 'agent.message', content: [{ type: 'text', text: 'Opened [warehouse#1187](https://github.com/data-platform/warehouse/pull/1187). The shopify_v2 backfill on 2026-07-14 re-inserted 12 customers with a newer loaded_at; the model now keeps the latest row per customer_id (qualify row_number() = 1). Test evidence (fail → pass) is in the PR body. No downstream model references loaded_at from this table.' }] }],
      [272000, { type: 'span.model_request_end', model: 'gemini-2.5-pro', model_usage: { input_tokens: 61240, output_tokens: 4102 } }],
      [273000, { type: 'session.status_idle', stop_reason: 'end_turn' }],
    ],
  });

  // Terminated session: provider quota exhausted.
  addSession({
    agent: anomaly, env: prod,
    title: 'Daily anomaly scan — revenue metrics',
    status: 'terminated', stopReason: 'error', startedAgo: 33 * HOUR,
    lastError: { type: 'api_error', message: 'gemini-2.5-pro: 429 RESOURCE_EXHAUSTED — provider quota exceeded for project data-agents-prod', retry_status: 'exhausted' },
    events: [
      [0, { type: 'user.message', content: [{ type: 'text', text: 'Run the daily anomaly scan on core revenue metrics for 2026-07-14 (UTC close).' }] }],
      [1400, { type: 'session.status_running', worker_id: 'airflow-prod-worker-7f4c9' }],
      [9000, { type: 'agent.mcp_tool_use', server: 'snowflake', name: 'query', input: { sql: "SELECT metric, ds, value FROM analytics.metric_daily WHERE ds >= DATEADD('day', -35, '2026-07-14')" } }],
      [17000, { type: 'agent.mcp_tool_result', server: 'snowflake', output: { rows: 175, elapsed_ms: 5910 } }],
      [21000, { type: 'session.error', error: { type: 'api_error', message: 'gemini-2.5-pro: 429 RESOURCE_EXHAUSTED — provider quota exceeded for project data-agents-prod', retry_status: 'retrying' } }],
      [4 * MIN, { type: 'session.error', error: { type: 'api_error', message: 'gemini-2.5-pro: 429 RESOURCE_EXHAUSTED — retries exhausted after 4 attempts', retry_status: 'exhausted' } }],
      [4 * MIN + 2000, { type: 'session.status_terminated', stop_reason: 'error' }],
    ],
  });

  // Queued session awaiting a worker.
  addSession({
    agent: qa, env: staging,
    title: 'QA sweep — staging smoke test',
    status: 'queued', startedAgo: 22 * MIN,
    events: [
      [0, { type: 'user.message', content: [{ type: 'text', text: 'Run the abbreviated QA manifest against staging (qa/staging_smoke.yml).' }] }],
    ],
  });

  // Older short sessions to give the activity chart shape.
  const filler = [
    { agent: qa, days: 1.2, title: 'Nightly QA sweep — core marts', ok: true },
    { agent: qa, days: 2.2, title: 'Nightly QA sweep — core marts', ok: true },
    { agent: triage, days: 2.6, title: 'Triage: attribution_refresh timeout', ok: true },
    { agent: qa, days: 3.2, title: 'Nightly QA sweep — core marts', ok: true },
    { agent: anomaly, days: 4.1, title: 'Daily anomaly scan — revenue metrics', ok: true },
    { agent: qa, days: 4.2, title: 'Nightly QA sweep — core marts', ok: true },
    { agent: triage, days: 4.8, title: 'Triage: dw_core_load skipped partition', ok: false },
    { agent: qa, days: 5.2, title: 'Nightly QA sweep — core marts', ok: true },
    { agent: anomaly, days: 6.1, title: 'Daily anomaly scan — revenue metrics', ok: true },
    { agent: qa, days: 6.2, title: 'Nightly QA sweep — core marts', ok: true },
    { agent: prFixer, days: 7.5, title: 'Fix failing dbt test: not_null_fct_orders_order_id', ok: true },
    { agent: qa, days: 8.2, title: 'Nightly QA sweep — core marts', ok: true },
    { agent: anomaly, days: 9.1, title: 'Daily anomaly scan — revenue metrics', ok: true },
    { agent: qa, days: 10.2, title: 'Nightly QA sweep — core marts', ok: true },
    { agent: triage, days: 11.4, title: 'Triage: ml_features backfill OOM', ok: true },
    { agent: qa, days: 12.2, title: 'Nightly QA sweep — core marts', ok: true },
  ];
  for (const f of filler) {
    const dur = 3 * MIN + Math.floor((f.days * 37) % 7) * MIN;
    addSession({
      agent: f.agent, env: prod, title: f.title,
      status: f.ok ? 'idle' : 'terminated',
      stopReason: f.ok ? 'end_turn' : 'error',
      startedAgo: f.days * DAY,
      events: [
        [0, { type: 'user.message', content: [{ type: 'text', text: 'Scheduled run.' }] }],
        [1000, { type: 'session.status_running', worker_id: 'airflow-prod-worker-7f4c9' }],
        [dur - 2000, { type: 'span.model_request_end', model: f.agent.model.id, model_usage: { input_tokens: 9000 + Math.floor((f.days * 811) % 4000), output_tokens: 700 + Math.floor((f.days * 331) % 900) } }],
        [dur, f.ok
          ? { type: 'session.status_idle', stop_reason: 'end_turn' }
          : { type: 'session.status_terminated', stop_reason: 'error' }],
      ],
    });
  }

  // ------------------------------------------------------- deployments
  function addDeployment({ name, agent, env, prompt, expression, timezone, status, pausedReason = null, lastRunAgo = null }) {
    const deployment = store.insert('deployments', {
      id: newDeploymentId(), type: 'deployment',
      name,
      agent: agent.id,
      environment_id: env.id,
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }],
      schedule: {
        type: 'cron', expression, timezone,
        last_run_at: lastRunAgo == null ? null : iso(lastRunAgo),
      },
      status,
      paused_reason: pausedReason,
      next_run_at: status === 'active' ? nextRun(expression, timezone)?.toISOString() ?? null : null,
      created_at: iso(21 * DAY),
    });
    return deployment;
  }

  const nightlyQa = addDeployment({
    name: 'Nightly table QA sweep', agent: qa, env: prod,
    prompt: 'Run the nightly quality checks for the core mart tables (manifest: qa/core_marts.yml).',
    expression: '0 2 * * *', timezone: 'America/New_York',
    status: 'active', lastRunAgo: 11 * HOUR,
  });
  const dailyAnomaly = addDeployment({
    name: 'Daily anomaly scan', agent: anomaly, env: prod,
    prompt: 'Run the daily anomaly scan on core revenue metrics for the last UTC close.',
    expression: '30 13 * * *', timezone: 'UTC',
    status: 'active', lastRunAgo: 9 * MIN,
  });
  const weeklyDeep = addDeployment({
    name: 'Weekly deep QA (all schemas)', agent: qa, env: prod,
    prompt: 'Run the full QA manifest across all schemas, including cold tables (qa/full.yml).',
    expression: '0 6 * * 6', timezone: 'America/New_York',
    status: 'paused', pausedReason: { type: 'manual' }, lastRunAgo: 5 * DAY,
  });

  // Run history linking back to seeded sessions where it makes sense.
  const qaSessions = sessions.filter((s) => s.agent.id === qa.id && s.title.includes('Nightly'));
  let runIdx = 0;
  for (const session of qaSessions.slice(0, 6)) {
    store.insert('deployment_runs', {
      type: 'deployment_run', id: newDeploymentRunId(),
      deployment_id: nightlyQa.id,
      trigger_context: { type: 'schedule', scheduled_at: session.created_at },
      session_id: session.id,
      error: null,
      agent: { type: 'agent', id: qa.id, version: qa.version },
      created_at: session.created_at,
    });
    store.update('sessions', session.id, { deployment_run_id: store.all('deployment_runs').at(-1).id });
    runIdx++;
  }
  store.insert('deployment_runs', {
    type: 'deployment_run', id: newDeploymentRunId(),
    deployment_id: nightlyQa.id,
    trigger_context: { type: 'schedule', scheduled_at: iso(7.2 * DAY) },
    session_id: null,
    error: { type: 'session_rate_limited_error', message: 'session creation was rate limited; the schedule will try again at the next occurrence' },
    agent: { type: 'agent', id: qa.id, version: qa.version },
    created_at: iso(7.2 * DAY),
  });
  const anomalySessions = sessions.filter((s) => s.agent.id === anomaly.id);
  for (const session of anomalySessions) {
    store.insert('deployment_runs', {
      type: 'deployment_run', id: newDeploymentRunId(),
      deployment_id: dailyAnomaly.id,
      trigger_context: { type: 'schedule', scheduled_at: session.created_at },
      session_id: session.id,
      error: null,
      agent: { type: 'agent', id: anomaly.id, version: anomaly.version },
      created_at: session.created_at,
    });
    store.update('sessions', session.id, { deployment_run_id: store.all('deployment_runs').at(-1).id });
  }

  // ------------------------------------------------------ provider key
  store.insert('provider_keys', {
    id: newKeyId(), type: 'provider_key',
    provider: 'google',
    name: 'Gemini — data-platform (demo)',
    value: 'AIzaSyDEMO0000000000000000000000000demo',
    created_at: iso(20 * DAY),
    last_used_at: iso(9 * MIN),
  });
}

// CLI: node seed.mjs --reset
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const dataDir = process.env.GANTRY_DATA_DIR
    || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
  if (process.argv.includes('--reset')) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('[gantry] cleared', dataDir);
  }
  const store = new Store(dataDir);
  if (!store.isEmpty()) {
    console.error('[gantry] data directory is not empty; run with --reset to reseed');
    process.exit(1);
  }
  seed(store);
  console.log('[gantry] seeded demo workspace at', dataDir);
}
