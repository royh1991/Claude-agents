import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createApp } from '../app.mjs';
import { validateInstance, checkSchemaSubset } from '../lib/schema_subset.mjs';
import { instanceFromSchema } from '../lib/runs.mjs';

// Copy the fixture into a temp dir so publish tests never dirty the repo.
const fixtureRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'backend-fixture');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-backend-'));
fs.cpSync(fixtureRoot, tmpRoot, { recursive: true });

const app = createApp({ BACKEND_REPO_ROOT: tmpRoot });
const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const base = `http://localhost:${server.address().port}`;

test.after(() => {
  app.locals.runAdapter.close?.();
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function call(method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const GOOD_AGENT = {
  type: 'agent',
  id: 'table-qa-sentinel',
  version: 1,
  name: 'Table QA Sentinel',
  description: 'Runs daily quality checks on warehouse tables.',
  model: 'gemini-2.5-flash',
  system: 'You run data quality checks against the analytics warehouse.\nSummarize regressions clearly.',
  tools: ['dbt_show_query', 'file_read'],
  skills: ['dbt'],
  response_format: 'anomaly_report',
  metadata: { owner_team: 'Analytics Eng', default_repository_aliases: ['credible-dbt'], notification_defaults: [{ type: 'slack' }] },
};

test('catalog reads all backend collections', async () => {
  const { body } = await call('GET', '/api/catalog');
  assert.deepEqual(body.agents.map((a) => a.id), ['airflow-failure-triage', 'anomaly-detector']);
  assert.ok(body.skills.length >= 4);
  assert.deepEqual(body.tools.map((t) => t.name), ['dbt_show_query', 'file_list', 'file_read']);
  assert.deepEqual(body.environments.map((e) => e.id), ['airflow-triage-runtime']);
  assert.ok(body.guardrails.includes('Read-only'));
});

test('agent validation mirrors backend rules', async () => {
  const bad = await call('POST', '/api/agents/preview', {
    config: {
      type: 'agent', id: 'Bad ID!', version: 0, name: '', model: '',
      system: 'Use __INPUT_JSON__ here.',
      tools: ['drop_tables'], skills: ['nonexistent'], response_format: 'missing_format',
    },
  });
  const text = bad.body.problems.join('\n');
  assert.match(text, /id: must match/);
  assert.match(text, /version: must be an integer/);
  assert.match(text, /tools: "drop_tables"/);
  assert.match(text, /skills: "nonexistent"/);
  assert.match(text, /response_format: "missing_format"/);
  assert.match(bad.body.warnings.join('\n'), /__TOKEN__ placeholders/);
});

test('preview generates round-trippable canonical YAML', async () => {
  const { body } = await call('POST', '/api/agents/preview', { config: GOOD_AGENT });
  assert.deepEqual(body.problems, []);
  const parsed = YAML.parse(body.yaml);
  assert.equal(parsed.type, 'agent');
  assert.equal(parsed.id, GOOD_AGENT.id);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.model, 'gemini-2.5-flash');
  assert.ok(parsed.system.includes('quality checks'));
  assert.deepEqual(parsed.tools, GOOD_AGENT.tools);
  assert.deepEqual(parsed.metadata.default_repository_aliases, ['credible-dbt']);
  assert.match(body.yaml, /\nsystem: \|/); // block literal, not quoted
});

test('publish writes only agents/<id>/agent.yaml and guards overwrites', async () => {
  const first = await call('POST', '/api/agents/publish', { config: GOOD_AGENT });
  assert.equal(first.status, 200);
  assert.equal(first.body.path, 'dags/credible_bi_airflow_triage/agents/table-qa-sentinel/agent.yaml');
  assert.ok(fs.existsSync(path.join(tmpRoot, first.body.path)));

  const clobber = await call('POST', '/api/agents/publish', { config: GOOD_AGENT });
  assert.equal(clobber.status, 409);

  const over = await call('POST', '/api/agents/publish', {
    config: { ...GOOD_AGENT, version: 2 }, overwrite: true,
  });
  assert.equal(over.status, 200);
  assert.ok(over.body.previous_yaml.includes('version: 1'));

  // The published agent shows up in the catalog (repo-as-database).
  const cat = await call('GET', '/api/catalog');
  assert.ok(cat.body.agents.some((a) => a.id === 'table-qa-sentinel' && a.config.version === 2));

  // Path traversal is impossible by construction (id regex), but the guard holds.
  const evil = await call('POST', '/api/agents/publish', {
    config: { ...GOOD_AGENT, id: '../../escape' },
  });
  assert.equal(evil.status, 400);
});

test('trigger publish validates and writes agent_triggers/<id>.yaml', async () => {
  const config = {
    type: 'trigger',
    id: 'dbt-core-failure-triage',
    description: 'Fire triage on dbt-core failures',
    agent: { id: 'airflow-failure-triage' },
    source: { dag_id: 'dbt-core', event: 'on_failure' },
    request: {
      response_format: 'failure_triage_report',
      resources: [],
      message: 'Triage the failed dbt-core build using the attached run context.',
    },
  };
  const preview = await call('POST', '/api/triggers/preview', { config });
  assert.deepEqual(preview.body.problems, []);
  const pub = await call('POST', '/api/triggers/publish', { config });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.path, 'dags/credible_bi_airflow_triage/agent_triggers/dbt-core-failure-triage.yaml');

  const missingMsg = await call('POST', '/api/triggers/preview', {
    config: { ...config, request: { ...config.request, message: '' } },
  });
  assert.match(missingMsg.body.problems.join('\n'), /request.message/);
});

test('session envelope validation enforces the backend request contract', async () => {
  const bad = await call('POST', '/api/runs', {
    envelope: {
      type: 'session',
      agent: { id: 'no-such-agent', version: 9 },
      environment_id: 'somewhere-else',
      events: [],
    },
  });
  assert.equal(bad.status, 400);
  const text = bad.body.error.details.join('\n');
  assert.match(text, /agent.id/);
  assert.match(text, /environment_id/);
  assert.match(text, /events: required/);

  const wrongVersion = await call('POST', '/api/runs', {
    envelope: {
      type: 'session',
      agent: { id: 'anomaly-detector', version: 99 },
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'go' }] }],
    },
  });
  assert.match(wrongVersion.body.error.details.join('\n'), /does not match the checked-in version/);
});

test('mock run lifecycle: trigger → running → success with schema-valid result', async () => {
  const trigger = await call('POST', '/api/runs', {
    envelope: {
      type: 'session',
      agent: { type: 'agent', id: 'anomaly-detector', version: 1 },
      environment_id: 'airflow-triage-runtime',
      title: 'test run',
      response_format: 'anomaly_report',
      resources: [{ type: 'repository_alias', alias: 'credible-dbt' }],
      metadata: { dbt_asset: 'fct_orders', grain: 'day' },
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'Scan fct_orders.' }] }],
    },
  });
  assert.equal(trigger.status, 200);
  const id = encodeURIComponent(trigger.body.dag_run_id);

  // Wait for the simulated pipeline to finish (~6s).
  let detail;
  for (let i = 0; i < 40; i++) {
    detail = (await call('GET', `/api/runs/${id}`)).body;
    if (detail.run.state === 'success') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(detail.run.state, 'success');
  assert.equal(detail.result.status, 'success');
  assert.equal(detail.result.agent_id, 'anomaly-detector');
  assert.deepEqual(detail.tasks.map((t) => t.state), ['success', 'success', 'success', 'success']);

  // The mock result must validate against the selected response format.
  const cat = (await call('GET', '/api/catalog')).body;
  const schema = cat.response_formats.find((f) => f.name === 'anomaly_report').schema;
  assert.deepEqual(validateInstance(detail.result.result, schema), []);
});

test('schema subset checker rejects unsupported keywords', () => {
  assert.deepEqual(checkSchemaSubset({ type: 'object', properties: { a: { type: 'string' } } }), []);
  const problems = checkSchemaSubset({ type: 'object', oneOf: [], properties: { a: { pattern: 'x' } } });
  assert.equal(problems.length, 2);
});

test('instanceFromSchema produces schema-valid instances', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'items', 'level'],
    properties: {
      title: { type: 'string', minLength: 1 },
      items: { type: 'array', minItems: 2, items: { type: 'object', required: ['k'], properties: { k: { type: 'string' } } } },
      level: { type: 'string', enum: ['low', 'high'] },
    },
  };
  assert.deepEqual(validateInstance(instanceFromSchema(schema), schema), []);
});
