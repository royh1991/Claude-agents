// Run adapters: submit session envelopes to the ai-agent-runner DAG and
// read run state back. Two implementations behind one interface:
//   AirflowAdapter — proxies the Airflow REST API (credentials stay server-side).
//   MockAdapter   — an in-memory simulation for local dev and demos, faithful
//                   to the DAG task graph and the runtime result contract.
import crypto from 'node:crypto';
import { validateInstance } from './schema_subset.mjs';

export const DAG_TASKS = ['build-request', 'run-agent', 'evaluate-result', 'post-notifications'];
export const RESULT_STATUSES = ['success', 'invalid_input', 'resource_error', 'provider_error', 'invalid_output', 'runtime_error'];
const MAX_REQUEST_BYTES = 60000; // contracts.py MAX_REQUEST_BYTES — env-var transport limit

export function validateSessionEnvelope(envelope, catalog) {
  const problems = [];
  if (!envelope || typeof envelope !== 'object') return ['envelope must be an object'];
  if (envelope.type !== 'session') problems.push('type: must be "session"');
  const agentId = envelope.agent?.id;
  const agent = (catalog?.agents ?? []).find((a) => a.id === agentId);
  if (!agentId) {
    problems.push('agent.id: required');
  } else if (!agent) {
    problems.push(`agent.id: "${agentId}" does not resolve to an agent pack`);
  } else if (envelope.agent.version != null && agent.config?.version != null
    && envelope.agent.version !== agent.config.version) {
    problems.push(`agent.version: ${envelope.agent.version} does not match the checked-in version ${agent.config.version}`);
  }
  if (envelope.agent?.type != null && envelope.agent.type !== 'agent') {
    problems.push('agent.type: must be "agent" when present');
  }
  // The backend's load_environment accepts exactly this id today, regardless
  // of what exists under environments/ — mirror that, not the directory.
  if (envelope.environment_id != null && envelope.environment_id !== 'airflow-triage-runtime') {
    problems.push(`environment_id: "${envelope.environment_id}" is not accepted — only "airflow-triage-runtime" exists`);
  }
  const events = envelope.events;
  if (!Array.isArray(events) || events.length === 0) {
    problems.push('events: required, non-empty — v1 supports user.message events');
  } else {
    events.forEach((event, i) => {
      if (event?.type !== 'user.message') {
        problems.push(`events[${i}].type: v1 supports only "user.message"`);
        return;
      }
      // The validator must be total over arbitrary JSON — a malformed
      // request may never throw out of the route handler.
      if (!Array.isArray(event.content)) {
        problems.push(`events[${i}].content: must be an array of content blocks`);
        return;
      }
      const texts = event.content.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim());
      if (texts.length === 0) problems.push(`events[${i}]: needs at least one non-empty text content block`);
    });
  }
  if (envelope.resources != null && !Array.isArray(envelope.resources)) {
    problems.push('resources: must be an array');
  }
  for (const [i, resource] of (Array.isArray(envelope.resources) ? envelope.resources : []).entries()) {
    if (resource?.type === 'repository_alias') {
      if (!resource.alias) problems.push(`resources[${i}]: repository_alias needs an "alias"`);
    } else if (resource?.type !== 'dbt_artifacts') {
      problems.push(`resources[${i}]: unsupported type "${resource?.type}" (repository_alias | dbt_artifacts)`);
    }
  }
  if (envelope.response_format != null) {
    const formats = new Set((catalog?.response_formats ?? []).map((f) => f.name));
    if (!formats.has(envelope.response_format)) {
      problems.push(`response_format: "${envelope.response_format}" not found in response_formats/`);
    }
  }
  const size = Buffer.byteLength(JSON.stringify(envelope));
  if (size > MAX_REQUEST_BYTES) {
    problems.push(`request is ${size} bytes; it must stay under ${MAX_REQUEST_BYTES} (transported to the pod as an env var)`);
  }
  return problems;
}

// ------------------------------------------------------------- Airflow

export class AirflowAdapter {
  constructor(env = process.env) {
    this.base = env.AIRFLOW_BASE_URL.replace(/\/$/, '');
    this.dagId = env.AIRFLOW_DAG_ID ?? 'ai-agent-runner';
    this.headers = { 'content-type': 'application/json' };
    if (env.AIRFLOW_TOKEN) {
      this.headers.authorization = `Bearer ${env.AIRFLOW_TOKEN}`;
    } else if (env.AIRFLOW_USERNAME) {
      const cred = Buffer.from(`${env.AIRFLOW_USERNAME}:${env.AIRFLOW_PASSWORD ?? ''}`).toString('base64');
      this.headers.authorization = `Basic ${cred}`;
    }
  }

  get mode() { return 'airflow'; }

  async #call(method, pathname, body) {
    const res = await fetch(`${this.base}/api/v1${pathname}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Airflow ${method} ${pathname} → ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async trigger(envelope) {
    const agentId = envelope.agent?.id ?? 'agent';
    const dagRunId = `console__${agentId}__${new Date().toISOString().replace(/[:.]/g, '-')}__${crypto.randomBytes(3).toString('hex')}`;
    // Body stays exactly {dag_run_id, conf}: Airflow's schema rejects
    // unknown fields, and e.g. `note` only exists from 2.5 onward.
    const created = await this.#call('POST', `/dags/${this.dagId}/dagRuns`, {
      dag_run_id: dagRunId,
      conf: envelope,
    });
    return { dag_run_id: created.dag_run_id };
  }

  async list(limit = 50) {
    const res = await this.#call('GET', `/dags/${this.dagId}/dagRuns?order_by=-logical_date&limit=${limit}`);
    return (res.dag_runs ?? []).map((run) => this.#summary(run));
  }

  async get(dagRunId) {
    const encoded = encodeURIComponent(dagRunId);
    const run = await this.#call('GET', `/dags/${this.dagId}/dagRuns/${encoded}`);
    const tis = await this.#call('GET', `/dags/${this.dagId}/dagRuns/${encoded}/taskInstances`);
    const tasks = (tis.task_instances ?? [])
      .filter((t) => DAG_TASKS.includes(t.task_id))
      .sort((a, b) => DAG_TASKS.indexOf(a.task_id) - DAG_TASKS.indexOf(b.task_id))
      .map((t) => ({
        task_id: t.task_id,
        state: t.state,
        start_date: t.start_date,
        end_date: t.end_date,
        try_number: t.try_number,
      }));
    let result = null;
    let resultRaw = null;
    try {
      const xcom = await this.#call('GET',
        `/dags/${this.dagId}/dagRuns/${encoded}/taskInstances/run-agent/xcomEntries/return_value`);
      if (typeof xcom.value === 'string') {
        try {
          result = JSON.parse(xcom.value);
        } catch {
          // Not JSON (unexpected serialization) — surface it raw rather
          // than silently dropping the run's output.
          resultRaw = xcom.value;
        }
      } else {
        result = xcom.value ?? null;
      }
    } catch (err) {
      // Only "no XCom yet" (run still executing / run-agent never ran) is
      // benign. Auth or server errors must surface, not masquerade as a
      // still-running result.
      if (err.status !== 404) throw err;
    }
    return { run: this.#summary(run), tasks, result, result_raw: resultRaw };
  }

  #summary(run) {
    const conf = run.conf ?? {};
    return {
      dag_run_id: run.dag_run_id,
      state: run.state,
      agent_id: conf.agent?.id ?? conf.agent_id ?? null,
      title: conf.title ?? null,
      response_format: conf.response_format ?? null,
      logical_date: run.logical_date ?? run.execution_date ?? null,
      start_date: run.start_date ?? null,
      end_date: run.end_date ?? null,
      conf,
    };
  }
}

// --------------------------------------------------------------- Mock

// Generate a minimal schema-valid instance for any subset schema, so mock
// results always match the selected response format — including formats a
// user authored five minutes ago.
export function instanceFromSchema(schema, seedText = 'Mock value') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'string': return seedText;
    case 'integer': return schema.minimum ?? 1;
    case 'number': return schema.minimum ?? 1;
    case 'boolean': return false;
    case 'array': {
      const n = schema.minItems ?? 1;
      return Array.from({ length: n }, (_, i) => instanceFromSchema(schema.items ?? { type: 'string' }, `${seedText} ${i + 1}`));
    }
    case 'object':
    default: {
      const out = {};
      for (const key of schema.required ?? Object.keys(schema.properties ?? {})) {
        out[key] = instanceFromSchema(schema.properties?.[key] ?? { type: 'string' }, `${seedText}: ${key}`);
      }
      return out;
    }
  }
}

const MOCK_RESULTS = {
  failure_triage_report: (conf) => ({
    title: `Triage: ${conf.metadata?.dag_id ?? 'dw_core_load'} failed at ${conf.metadata?.task_id ?? 'load_fct_orders'}`,
    summary: "Today's orders export contains the literal string 'N/A' in amount; COPY INTO fct_orders_stage fails with Snowflake error 100038. Yesterday's load on the same code succeeded, so this is an upstream export regression, not a warehouse change.",
    root_cause_hypothesis: 'Checkout release v214 changed the orders export serializer to emit N/A for null amounts.',
    evidence: [
      { source: 'task log attempt=2', detail: "snowflake.connector 100038 (22018): Numeric value 'N/A' is not recognized in column AMOUNT, file orders_part-0007.csv.gz line 18422" },
      { source: 'stage query', detail: '412 rows in today\'s partition have non-numeric amount; zero rows yesterday' },
    ],
    recommended_actions: [
      'Ask the orders service team to revert the export serializer change (v214).',
      'Mitigate: stage with TRY_TO_NUMBER(amount) and a reject table so one bad partition cannot block the load.',
    ],
    severity: 'high',
    confidence: 'high',
  }),
  anomaly_report: (conf) => ({
    title: `Anomaly scan: ${conf.metadata?.dbt_asset ?? 'submissions_output'} (${conf.metadata?.grain ?? 'day'})`,
    summary: 'refund_rate for the latest close is z = 3.6 against the 28-day weekday baseline; all other core metrics are within 1.2 MAD of baseline.',
    anomaly_detected: true,
    findings: [
      { metric: 'refund_rate', observation: '4.1% vs 1.9% weekday baseline (z = 3.6), sustained across the full day', driver: 'web platform, NA region — 82% of the excess' },
      { metric: 'gross_revenue', observation: 'within baseline (z = 0.4)' },
    ],
    query_proof: [
      "SELECT metric, ds, value FROM analytics.metric_daily WHERE ds >= DATEADD('day', -35, CURRENT_DATE)",
      "SELECT region, platform, refund_rate FROM analytics.metric_daily_dims WHERE ds = CURRENT_DATE - 1 ORDER BY refund_rate DESC LIMIT 20",
    ],
    recommended_actions: [
      'Page the payments on-call: the refund spike is isolated to web/NA and started at 14:00 UTC.',
      'Re-run the scan after the payments incident closes to confirm recovery.',
    ],
    severity: 'medium',
    confidence: 'high',
  }),
};

export class MockAdapter {
  constructor(catalogProvider) {
    this.catalogProvider = catalogProvider;
    this.runs = new Map(); // dag_run_id -> {run, tasks, result}
    this.timers = new Set();
    this.#seed();
  }

  get mode() { return 'mock'; }

  close() {
    for (const t of this.timers) clearTimeout(t);
  }

  #schedule(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    if (typeof t.unref === 'function') t.unref();
    this.timers.add(t);
  }

  #resultFor(envelope) {
    const catalog = this.catalogProvider();
    const agent = catalog.agents.find((a) => a.id === envelope.agent?.id);
    const formatName = envelope.response_format
      ?? agent?.config?.response_format
      ?? null;
    const format = catalog.response_formats.find((f) => f.name === formatName);
    let result;
    if (formatName && Object.hasOwn(MOCK_RESULTS, formatName)) {
      result = MOCK_RESULTS[formatName](envelope);
    } else if (format?.schema) {
      result = instanceFromSchema(format.schema, 'Mock');
    } else {
      result = { note: 'mock run with no response format' };
    }
    if (format?.schema) {
      const errs = validateInstance(result, format.schema);
      if (errs.length) result = instanceFromSchema(format.schema, 'Mock');
    }
    return {
      agent_id: agent?.id ?? envelope.agent?.id,
      agent_name: agent?.config?.name ?? envelope.agent?.id,
      status: 'success',
      result,
      error: null,
      raw_output: JSON.stringify(result).slice(0, 2000),
      session_id: `sesn_${(agent?.id ?? 'agent').replace(/-/g, '_')}_${Date.now()}`,
      environment_id: envelope.environment_id ?? 'airflow-triage-runtime',
      agent_version: agent?.config?.version ?? 1,
      resource_context: {
        workspace_root: '/workspace',
        repositories: (envelope.resources ?? [])
          .filter((r) => r.type === 'repository_alias')
          .map((r) => ({ alias: r.alias, path: `./${r.alias}` })),
      },
      provider: { kind: 'gemini-cli' },
    };
  }

  #errorResult(envelope, status, message) {
    const base = this.#resultFor(envelope);
    return { ...base, status, result: null, raw_output: '', resource_context: null, error: { code: status, message } };
  }

  async trigger(envelope) {
    const dagRunId = `console__${envelope.agent?.id ?? 'agent'}__${new Date().toISOString().replace(/[:.]/g, '-')}__${crypto.randomBytes(3).toString('hex')}`;
    const now = () => new Date().toISOString();
    const entry = {
      run: {
        dag_run_id: dagRunId, state: 'queued',
        agent_id: envelope.agent?.id ?? null,
        title: envelope.title ?? null,
        response_format: envelope.response_format ?? null,
        logical_date: now(), start_date: null, end_date: null, conf: envelope,
      },
      tasks: DAG_TASKS.map((task_id) => ({ task_id, state: null, start_date: null, end_date: null, try_number: 0 })),
      result: null,
    };
    this.runs.set(dagRunId, entry);
    this.#schedule(() => {
      entry.run.state = 'running';
      entry.run.start_date = now();
      entry.tasks[0] = { ...entry.tasks[0], state: 'success', start_date: now(), end_date: now(), try_number: 1 };
      entry.tasks[1] = { ...entry.tasks[1], state: 'running', start_date: now(), try_number: 1 };
    }, 900);
    this.#schedule(() => {
      entry.result = this.#resultFor(envelope);
      entry.tasks[1] = { ...entry.tasks[1], state: 'success', end_date: now() };
      entry.tasks[2] = { ...entry.tasks[2], state: 'success', start_date: now(), end_date: now(), try_number: 1 };
      entry.tasks[3] = { ...entry.tasks[3], state: 'success', start_date: now(), end_date: now(), try_number: 1 };
      entry.run.state = 'success';
      entry.run.end_date = now();
    }, 6000);
    return { dag_run_id: dagRunId };
  }

  async list(limit = 50) {
    return [...this.runs.values()]
      .map((e) => e.run)
      .sort((a, b) => (b.logical_date ?? '').localeCompare(a.logical_date ?? ''))
      .slice(0, limit);
  }

  async get(dagRunId) {
    const entry = this.runs.get(dagRunId);
    if (!entry) return null;
    return { run: entry.run, tasks: entry.tasks, result: entry.result };
  }

  #seedRun({ agentId, title, minutesAgo, status, message, envelopeExtra = {}, running = false }) {
    const envelope = {
      type: 'session',
      agent: { type: 'agent', id: agentId },
      environment_id: 'airflow-triage-runtime',
      title,
      events: [{ type: 'user.message', content: [{ type: 'text', text: message }] }],
      ...envelopeExtra,
    };
    const t0 = new Date(Date.now() - minutesAgo * 60000);
    const iso = (offsetSec) => new Date(t0.getTime() + offsetSec * 1000).toISOString();
    const ok = status === 'success';
    const dagRunId = `scheduled__${agentId}__${t0.toISOString().replace(/[:.]/g, '-')}`;
    const result = running ? null
      : ok ? this.#resultFor(envelope)
        : this.#errorResult(envelope, status,
          status === 'resource_error'
            ? 'Failed to clone repository `credible-dbt`: remote hung up unexpectedly'
            : 'Model output did not match response format schema: $.severity: must be one of ["low","medium","high"]');
    const doneState = ok ? 'success' : 'failed';
    this.runs.set(dagRunId, {
      run: {
        dag_run_id: dagRunId,
        state: running ? 'running' : doneState,
        agent_id: agentId, title,
        response_format: envelope.response_format ?? null,
        logical_date: iso(0), start_date: iso(2),
        end_date: running ? null : iso(190),
        conf: envelope,
      },
      tasks: [
        { task_id: 'build-request', state: 'success', start_date: iso(2), end_date: iso(4), try_number: 1 },
        { task_id: 'run-agent', state: running ? 'running' : 'success', start_date: iso(5), end_date: running ? null : iso(170), try_number: 1 },
        { task_id: 'evaluate-result', state: running ? null : (ok ? 'success' : 'failed'), start_date: running ? null : iso(172), end_date: running ? null : iso(173), try_number: running ? 0 : 1 },
        { task_id: 'post-notifications', state: running ? null : 'success', start_date: running ? null : iso(175), end_date: running ? null : iso(178), try_number: running ? 0 : 1 },
      ],
      result,
    });
  }

  #seed() {
    this.#seedRun({
      agentId: 'anomaly-detector',
      title: 'dbt-core-anomaly-canary / submissions_output',
      minutesAgo: 14, running: true, status: 'success',
      message: 'Inspect recent daily behavior of submissions_output at day grain.',
      envelopeExtra: {
        response_format: 'anomaly_report',
        resources: [{ type: 'repository_alias', alias: 'credible-dbt' }],
        metadata: { dbt_asset: 'submissions_output', grain: 'day', lookback_days: 35 },
      },
    });
    this.#seedRun({
      agentId: 'airflow-failure-triage',
      title: 'dbt-core / dw_core_load failure',
      minutesAgo: 310, status: 'success',
      message: 'Triage the failed dw_core_load run (task load_fct_orders, attempt 2).',
      envelopeExtra: {
        response_format: 'failure_triage_report',
        metadata: { dag_id: 'dw_core_load', task_id: 'load_fct_orders', run_id: 'scheduled__2026-07-16T06:00:00', log_url: 'https://airflow.internal/log?dag_id=dw_core_load' },
      },
    });
    this.#seedRun({
      agentId: 'anomaly-detector',
      title: 'dbt-core-anomaly-canary / submissions_output',
      minutesAgo: 1450, status: 'success',
      message: 'Inspect recent daily behavior of submissions_output at day grain.',
      envelopeExtra: {
        response_format: 'anomaly_report',
        resources: [{ type: 'repository_alias', alias: 'credible-dbt' }],
        metadata: { dbt_asset: 'submissions_output', grain: 'day' },
      },
    });
    this.#seedRun({
      agentId: 'airflow-failure-triage',
      title: 'dbt-core-triage-canary / intentional failure',
      minutesAgo: 2900, status: 'invalid_output',
      message: 'Triage the failed triage-canary build.',
      envelopeExtra: { response_format: 'failure_triage_report', metadata: { dag_id: 'dbt-core-triage-canary' } },
    });
    this.#seedRun({
      agentId: 'anomaly-detector',
      title: 'ad-hoc: fct_orders revenue check',
      minutesAgo: 4300, status: 'resource_error',
      message: 'Check fct_orders revenue for anomalies over the last 35 days.',
      envelopeExtra: {
        response_format: 'anomaly_report',
        resources: [{ type: 'repository_alias', alias: 'credible-dbt' }],
      },
    });
  }
}

export function createRunAdapter(env, catalogProvider) {
  if (env.AIRFLOW_BASE_URL) return new AirflowAdapter(env);
  return new MockAdapter(catalogProvider);
}
