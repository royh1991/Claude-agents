import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { createApp } from '../app.mjs';

// Boot one app on an ephemeral port against a throwaway data dir.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-test-'));
const store = new Store(dataDir);
const app = createApp(store);
const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const base = `http://localhost:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Shared fixtures, created once in order.
const agent = (await call('POST', '/v1/agents', {
  name: 'Test agent',
  model: 'gemini-2.5-flash',
  system: 'You test things.',
  tools: [{ type: 'agent_toolset', config: { bash: true } }],
})).body;

const environment = (await call('POST', '/v1/environments', {
  name: 'test-env',
  config: { type: 'self_hosted', cluster: 'kind', namespace: 'test' },
})).body;

await call('POST', '/v1/provider_keys', {
  provider: 'google', value: 'AIzaTestKey000000000000', name: 'test key',
});

test('agent versioning: conflict, update, no-op, archive', async () => {
  assert.equal(agent.version, 1);

  const conflict = await call('POST', `/v1/agents/${agent.id}`, { version: 99, system: 'x' });
  assert.equal(conflict.status, 409);

  const updated = await call('POST', `/v1/agents/${agent.id}`, { version: 1, description: 'now with a description' });
  assert.equal(updated.body.version, 2);

  const noop = await call('POST', `/v1/agents/${agent.id}`, { version: 2, description: 'now with a description' });
  assert.equal(noop.body.version, 2); // unchanged config → no new version

  const versions = await call('GET', `/v1/agents/${agent.id}/versions`);
  assert.deepEqual(versions.body.data.map((v) => v.version), [2, 1]);
});

test('session lifecycle: queue → claim → worker events → idle', async () => {
  const session = (await call('POST', '/v1/sessions', {
    agent: agent.id,
    environment_id: environment.id,
    title: 'lifecycle test',
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'do the thing' }] }],
  })).body;
  assert.equal(session.status, 'queued');
  assert.ok(!('claim_token' in session), 'claim_token must not leak on the public surface');

  const claim = (await call('POST', '/v1/internal/claim', { environment_id: environment.id, worker_id: 'w1' })).body;
  assert.equal(claim.session.id, session.id);
  assert.equal(claim.session.status, 'running');
  assert.ok(claim.claim_token);
  assert.equal(claim.provider_key.provider, 'google');
  assert.equal(claim.events[0].type, 'user.message');

  // Without the token, worker posts are fenced off.
  const stale = await call('POST', `/v1/internal/sessions/${session.id}/events`, {
    events: [{ type: 'agent.message', content: [{ type: 'text', text: 'hijack' }] }],
  });
  assert.equal(stale.status, 409);

  const done = await call('POST', `/v1/internal/sessions/${session.id}/events`, {
    claim_token: claim.claim_token,
    events: [
      { type: 'agent.message', content: [{ type: 'text', text: 'did the thing' }] },
      { type: 'span.model_request_end', model: 'gemini-2.5-flash', model_usage: { input_tokens: 100, output_tokens: 20 } },
      { type: 'session.status_idle', stop_reason: 'end_turn' },
    ],
  });
  assert.equal(done.status, 200);

  const fresh = (await call('GET', `/v1/sessions/${session.id}`)).body;
  assert.equal(fresh.status, 'idle');
  assert.equal(fresh.stop_reason, 'end_turn');
  assert.deepEqual(fresh.usage, { input_tokens: 100, output_tokens: 20 });

  // A follow-up user message re-queues the idle session.
  await call('POST', `/v1/sessions/${session.id}/events`, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: 'one more thing' }] }],
  });
  assert.equal((await call('GET', `/v1/sessions/${session.id}`)).body.status, 'queued');

  // Interrupting a queued session terminates it directly.
  await call('POST', `/v1/sessions/${session.id}/events`, { events: [{ type: 'user.interrupt' }] });
  const stopped = (await call('GET', `/v1/sessions/${session.id}`)).body;
  assert.equal(stopped.status, 'terminated');
  assert.equal(stopped.stop_reason, 'interrupted');
});

test('idle with a mid-run user message re-queues instead of parking', async () => {
  const session = (await call('POST', '/v1/sessions', {
    agent: agent.id,
    environment_id: environment.id,
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'task' }] }],
  })).body;
  const claim = (await call('POST', '/v1/internal/claim', { environment_id: environment.id })).body;
  assert.equal(claim.session.id, session.id);

  // Steering arrives while the worker is running…
  await call('POST', `/v1/sessions/${session.id}/events`, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: 'also do X' }] }],
  });
  // …and the simple runner finishes without having seen it.
  await call('POST', `/v1/internal/sessions/${session.id}/events`, {
    claim_token: claim.claim_token,
    events: [{ type: 'session.status_idle', stop_reason: 'end_turn' }],
  });
  assert.equal((await call('GET', `/v1/sessions/${session.id}`)).body.status, 'queued');

  // Drain it so later tests see an empty queue.
  const reclaim = (await call('POST', '/v1/internal/claim', {})).body;
  await call('POST', `/v1/internal/sessions/${session.id}/events`, {
    claim_token: reclaim.claim_token,
    events: [{ type: 'session.status_idle', stop_reason: 'end_turn' }],
  });
});

test('status_rescheduled returns the session to the queue', async () => {
  const session = (await call('POST', '/v1/sessions', {
    agent: agent.id,
    environment_id: environment.id,
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'task' }] }],
  })).body;
  const claim = (await call('POST', '/v1/internal/claim', {})).body;
  await call('POST', `/v1/internal/sessions/${session.id}/events`, {
    claim_token: claim.claim_token,
    events: [{ type: 'session.status_rescheduled' }],
  });
  assert.equal((await call('GET', `/v1/sessions/${session.id}`)).body.status, 'queued');

  const reclaim = (await call('POST', '/v1/internal/claim', {})).body;
  await call('POST', `/v1/internal/sessions/${session.id}/events`, {
    claim_token: reclaim.claim_token,
    events: [{ type: 'session.status_idle', stop_reason: 'end_turn' }],
  });
});

test('stale-claim sweeper re-queues dead workers and rotates the fence', async () => {
  const session = (await call('POST', '/v1/sessions', {
    agent: agent.id,
    environment_id: environment.id,
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'task' }] }],
  })).body;
  const claim = (await call('POST', '/v1/internal/claim', {})).body;
  assert.equal(claim.session.id, session.id);

  // Simulate a worker that died an hour ago.
  store.update('sessions', session.id, {
    last_event_at: new Date(Date.now() - 60 * 60000).toISOString(),
  });
  app.locals.sweepStaleClaims();
  assert.equal((await call('GET', `/v1/sessions/${session.id}`)).body.status, 'queued');

  // The dead worker's token no longer works.
  const zombie = await call('POST', `/v1/internal/sessions/${session.id}/events`, {
    claim_token: claim.claim_token,
    events: [{ type: 'session.status_idle', stop_reason: 'end_turn' }],
  });
  assert.equal(zombie.status, 409);

  const reclaim = (await call('POST', '/v1/internal/claim', {})).body;
  await call('POST', `/v1/internal/sessions/${session.id}/events`, {
    claim_token: reclaim.claim_token,
    events: [{ type: 'session.status_idle', stop_reason: 'end_turn' }],
  });
});

test('deployments: validation, upcoming runs, pause, manual run, auto-pause', async () => {
  const badCron = await call('POST', '/v1/deployments', {
    name: 'bad', agent: agent.id, environment_id: environment.id,
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'go' }] }],
    schedule: { type: 'cron', expression: 'not a cron', timezone: 'UTC' },
  });
  assert.equal(badCron.status, 400);

  const deployment = (await call('POST', '/v1/deployments', {
    name: 'test schedule', agent: agent.id, environment_id: environment.id,
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'go' }] }],
    schedule: { type: 'cron', expression: '0 6 * * *', timezone: 'UTC' },
  })).body;
  assert.equal(deployment.status, 'active');
  assert.equal(deployment.schedule.upcoming_runs_at.length, 3);

  const paused = (await call('POST', `/v1/deployments/${deployment.id}/pause`)).body;
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.paused_reason, { type: 'manual' });
  assert.equal(paused.schedule.upcoming_runs_at.length, 0);
  await call('POST', `/v1/deployments/${deployment.id}/unpause`);

  const run = (await call('POST', `/v1/deployments/${deployment.id}/run`)).body;
  assert.equal(run.trigger_context.type, 'manual');
  assert.ok(run.session_id);
  assert.equal((await call('GET', `/v1/sessions/${run.session_id}`)).body.deployment_run_id, run.id);

  // Archive the environment: the next trigger records a typed failed run
  // and auto-pauses the schedule.
  await call('POST', `/v1/environments/${environment.id}/archive`);
  const failed = (await call('POST', `/v1/deployments/${deployment.id}/run`)).body;
  assert.equal(failed.session_id, null);
  assert.equal(failed.error.type, 'environment_archived_error');
  const after = (await call('GET', `/v1/deployments/${deployment.id}`)).body;
  assert.equal(after.status, 'paused');
  assert.equal(after.paused_reason.error.type, 'environment_archived_error');

  const withErrors = (await call('GET', `/v1/deployment_runs?deployment_id=${deployment.id}&has_error=true`)).body;
  assert.equal(withErrors.data.length, 1);
});

test('provider keys are masked on read and public events reject worker types', async () => {
  const keys = (await call('GET', '/v1/provider_keys')).body.data;
  assert.ok(keys[0].masked_value.includes('•'));
  assert.ok(!('value' in keys[0]));

  const sessions = (await call('GET', '/v1/sessions?limit=1')).body.data;
  const smuggle = await call('POST', `/v1/sessions/${sessions[0].id}/events`, {
    events: [{ type: 'agent.message', content: [{ type: 'text', text: 'spoofed' }] }],
  });
  assert.equal(smuggle.status, 400);
});
