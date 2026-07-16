import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import {
  newAgentId, newEnvironmentId, newSessionId,
  newDeploymentId, newDeploymentRunId, newKeyId,
} from './lib/ids.mjs';
import { upcomingRuns, nextRun, validateCron } from './lib/cron.mjs';

const USER_EVENT_TYPES = new Set([
  'user.message', 'user.interrupt', 'user.tool_confirmation', 'user.custom_tool_result',
]);

const WORKER_EVENT_TYPES = new Set([
  'agent.message', 'agent.thinking', 'agent.tool_use', 'agent.tool_result',
  'agent.mcp_tool_use', 'agent.mcp_tool_result', 'agent.thread_context_compacted',
  'session.status_running', 'session.status_idle', 'session.status_rescheduled',
  'session.status_terminated', 'session.error',
  'span.model_request_start', 'span.model_request_end',
]);

const PROVIDERS = new Set(['google', 'anthropic', 'openai']);

function apiError(res, status, type, message) {
  return res.status(status).json({ type: 'error', error: { type, message } });
}

function inferProvider(modelId) {
  if (/^gemini/i.test(modelId)) return 'google';
  if (/^claude/i.test(modelId)) return 'anthropic';
  if (/^(gpt|o\d)/i.test(modelId)) return 'openai';
  return 'google';
}

function normalizeModel(model) {
  if (typeof model === 'string') return { id: model, provider: inferProvider(model) };
  if (model && typeof model.id === 'string') {
    return { id: model.id, provider: model.provider ?? inferProvider(model.id) };
  }
  return null;
}

function maskKey(value) {
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${'•'.repeat(6)}${value.slice(-4)}`;
}

function publicKey(key) {
  const { value, ...rest } = key;
  return { ...rest, masked_value: maskKey(value) };
}

export function createApp(store) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // ---------------------------------------------------------------- helpers

  function agentSnapshot(agent) {
    return JSON.parse(JSON.stringify(agent));
  }

  function resolveAgentVersion(agentId, version) {
    const current = store.find('agents', agentId);
    if (!current) return null;
    if (version == null || version === current.version) return current;
    return store.all('agent_versions')
      .find((v) => v.id === agentId && v.version === version) ?? null;
  }

  // Sync session bookkeeping off the append-only event log.
  function appendAndSync(session, event) {
    const full = store.appendEvent(session.id, event);
    const patch = { last_event_at: full.created_at, updated_at: full.created_at };
    switch (full.type) {
      case 'session.status_running':
        patch.status = 'running';
        break;
      case 'session.status_idle':
        patch.status = 'idle';
        patch.stop_reason = full.stop_reason ?? 'end_turn';
        patch.interrupt_requested = false;
        break;
      case 'session.status_terminated':
        patch.status = 'terminated';
        patch.stop_reason = full.stop_reason ?? null;
        patch.interrupt_requested = false;
        break;
      case 'session.error':
        patch.last_error = full.error ?? null;
        break;
      case 'span.model_request_end': {
        const usage = session.usage ?? { input_tokens: 0, output_tokens: 0 };
        patch.usage = {
          input_tokens: usage.input_tokens + (full.model_usage?.input_tokens ?? 0),
          output_tokens: usage.output_tokens + (full.model_usage?.output_tokens ?? 0),
        };
        break;
      }
      case 'user.interrupt':
        if (session.status === 'running') patch.interrupt_requested = true;
        break;
      default:
        break;
    }
    store.update('sessions', session.id, patch);
    return full;
  }

  function createSession({ agentRef, environment_id, title, initial_events, deployment_run_id }) {
    const agentId = typeof agentRef === 'string' ? agentRef : agentRef?.id;
    const agent = store.find('agents', agentId);
    if (!agent) return { error: ['not_found_error', `agent ${agentId} not found`, 404] };
    if (agent.archived_at) return { error: ['agent_archived_error', `agent ${agentId} is archived`, 400] };
    const environment = store.find('environments', environment_id);
    if (!environment) return { error: ['not_found_error', `environment ${environment_id} not found`, 404] };
    if (environment.archived_at) return { error: ['environment_archived_error', `environment ${environment_id} is archived`, 400] };

    const now = new Date().toISOString();
    const session = store.insert('sessions', {
      id: newSessionId(),
      type: 'session',
      agent: { id: agent.id, version: agent.version },
      environment_id,
      title: title ?? null,
      status: 'queued',
      stop_reason: null,
      interrupt_requested: false,
      usage: { input_tokens: 0, output_tokens: 0 },
      deployment_run_id: deployment_run_id ?? null,
      last_error: null,
      created_at: now,
      updated_at: now,
      last_event_at: null,
    });
    for (const event of initial_events ?? []) {
      if (event?.type === 'user.message') appendAndSync(session, event);
    }
    return { session };
  }

  function deploymentPublic(deployment) {
    const { next_run_at, ...rest } = deployment;
    const schedule = { ...deployment.schedule };
    if (deployment.status === 'active') {
      try {
        schedule.upcoming_runs_at = upcomingRuns(schedule.expression, schedule.timezone)
          .map((d) => d.toISOString());
      } catch {
        schedule.upcoming_runs_at = [];
      }
    } else {
      schedule.upcoming_runs_at = [];
    }
    return { ...rest, schedule };
  }

  function triggerDeployment(deployment, triggerContext) {
    const now = new Date().toISOString();
    const agent = store.find('agents', typeof deployment.agent === 'string' ? deployment.agent : deployment.agent.id);
    const run = {
      type: 'deployment_run',
      id: newDeploymentRunId(),
      deployment_id: deployment.id,
      trigger_context: triggerContext,
      session_id: null,
      error: null,
      agent: agent ? { type: 'agent', id: agent.id, version: agent.version } : null,
      created_at: now,
    };
    const result = createSession({
      agentRef: deployment.agent,
      environment_id: deployment.environment_id,
      title: `${deployment.name} — ${now.slice(0, 16).replace('T', ' ')}`,
      initial_events: deployment.initial_events,
      deployment_run_id: run.id,
    });
    if (result.error) {
      const [type, message] = result.error;
      run.error = { type, message };
      // Unrecoverable configuration errors pause the schedule, mirroring the platform.
      if (type === 'environment_archived_error' || type === 'agent_archived_error' || type === 'not_found_error') {
        store.update('deployments', deployment.id, {
          status: 'paused',
          paused_reason: { type: 'error', error: { type, message } },
          next_run_at: null,
        });
      }
    } else {
      run.session_id = result.session.id;
      store.update('deployments', deployment.id, {
        schedule: { ...deployment.schedule, last_run_at: now },
      });
    }
    store.insert('deployment_runs', run);
    return run;
  }

  // Exposed for the scheduler loop in index.mjs.
  app.locals.tickSchedules = () => {
    const now = new Date();
    for (const deployment of store.all('deployments')) {
      if (deployment.status !== 'active' || !deployment.next_run_at) continue;
      if (new Date(deployment.next_run_at) > now) continue;
      const scheduledAt = deployment.next_run_at;
      const next = nextRun(deployment.schedule.expression, deployment.schedule.timezone, now);
      store.update('deployments', deployment.id, { next_run_at: next ? next.toISOString() : null });
      triggerDeployment(deployment, { type: 'schedule', scheduled_at: scheduledAt });
    }
  };

  // ---------------------------------------------------------------- agents

  app.post('/v1/agents', (req, res) => {
    const { name, model, system, description, tools, mcp_servers, skills, metadata } = req.body ?? {};
    if (!name || typeof name !== 'string') return apiError(res, 400, 'invalid_request_error', 'name is required');
    const normalizedModel = normalizeModel(model);
    if (!normalizedModel) return apiError(res, 400, 'invalid_request_error', 'model is required');
    const now = new Date().toISOString();
    const agent = {
      id: newAgentId(),
      type: 'agent',
      name,
      model: normalizedModel,
      system: system ?? null,
      description: description ?? null,
      tools: tools ?? [],
      mcp_servers: mcp_servers ?? [],
      skills: skills ?? [],
      metadata: metadata ?? {},
      version: 1,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    store.insert('agents', agent);
    store.insert('agent_versions', agentSnapshot(agent));
    res.status(200).json(agent);
  });

  app.get('/v1/agents', (req, res) => {
    let agents = store.all('agents');
    if (req.query.include_archived !== 'true') agents = agents.filter((a) => !a.archived_at);
    res.json({ data: [...agents].sort((a, b) => b.created_at.localeCompare(a.created_at)) });
  });

  app.get('/v1/agents/:id', (req, res) => {
    const agent = store.find('agents', req.params.id);
    if (!agent) return apiError(res, 404, 'not_found_error', `agent ${req.params.id} not found`);
    res.json(agent);
  });

  app.post('/v1/agents/:id', (req, res) => {
    const agent = store.find('agents', req.params.id);
    if (!agent) return apiError(res, 404, 'not_found_error', `agent ${req.params.id} not found`);
    if (agent.archived_at) return apiError(res, 400, 'invalid_request_error', 'agent is archived and read-only');
    const { version, ...updates } = req.body ?? {};
    if (version !== agent.version) {
      return apiError(res, 409, 'conflict_error',
        `version mismatch: agent is at version ${agent.version}`);
    }
    const next = agentSnapshot(agent);
    let changed = false;
    for (const field of ['name', 'system', 'description']) {
      if (field in updates && JSON.stringify(updates[field] ?? null) !== JSON.stringify(next[field])) {
        if (field === 'name' && !updates.name) return apiError(res, 400, 'invalid_request_error', 'name cannot be cleared');
        next[field] = updates[field] ?? null;
        changed = true;
      }
    }
    if ('model' in updates) {
      const normalizedModel = normalizeModel(updates.model);
      if (!normalizedModel) return apiError(res, 400, 'invalid_request_error', 'model cannot be cleared');
      if (JSON.stringify(normalizedModel) !== JSON.stringify(next.model)) {
        next.model = normalizedModel;
        changed = true;
      }
    }
    for (const field of ['tools', 'mcp_servers', 'skills']) {
      if (field in updates) {
        const replacement = updates[field] ?? [];
        if (JSON.stringify(replacement) !== JSON.stringify(next[field])) {
          next[field] = replacement;
          changed = true;
        }
      }
    }
    if ('metadata' in updates && updates.metadata) {
      for (const [k, v] of Object.entries(updates.metadata)) {
        if (v === null) { if (k in next.metadata) { delete next.metadata[k]; changed = true; } }
        else if (JSON.stringify(next.metadata[k]) !== JSON.stringify(v)) { next.metadata[k] = v; changed = true; }
      }
    }
    if (!changed) return res.json(agent); // no-op detection
    next.version = agent.version + 1;
    next.updated_at = new Date().toISOString();
    store.update('agents', agent.id, next);
    store.insert('agent_versions', agentSnapshot(next));
    res.json(next);
  });

  app.post('/v1/agents/:id/archive', (req, res) => {
    const agent = store.find('agents', req.params.id);
    if (!agent) return apiError(res, 404, 'not_found_error', `agent ${req.params.id} not found`);
    if (!agent.archived_at) store.update('agents', agent.id, { archived_at: new Date().toISOString() });
    res.json(store.find('agents', agent.id));
  });

  app.get('/v1/agents/:id/versions', (req, res) => {
    const versions = store.all('agent_versions')
      .filter((v) => v.id === req.params.id)
      .sort((a, b) => b.version - a.version);
    res.json({ data: versions });
  });

  // ---------------------------------------------------------- environments

  app.post('/v1/environments', (req, res) => {
    const { name, config } = req.body ?? {};
    if (!name) return apiError(res, 400, 'invalid_request_error', 'name is required');
    const now = new Date().toISOString();
    const environment = store.insert('environments', {
      id: newEnvironmentId(),
      type: 'environment',
      name,
      config: {
        type: config?.type ?? 'self_hosted',
        cluster: config?.cluster ?? null,
        namespace: config?.namespace ?? null,
        network_policy: config?.network_policy ?? 'vpc_only',
        credentials: config?.credentials ?? [],
      },
      worker: { status: 'never_seen', last_seen_at: null, worker_id: null },
      created_at: now,
      archived_at: null,
    });
    res.json(environment);
  });

  app.get('/v1/environments', (req, res) => {
    res.json({ data: store.all('environments') });
  });

  app.get('/v1/environments/:id', (req, res) => {
    const environment = store.find('environments', req.params.id);
    if (!environment) return apiError(res, 404, 'not_found_error', `environment ${req.params.id} not found`);
    res.json(environment);
  });

  app.post('/v1/environments/:id/archive', (req, res) => {
    const environment = store.find('environments', req.params.id);
    if (!environment) return apiError(res, 404, 'not_found_error', `environment ${req.params.id} not found`);
    if (!environment.archived_at) store.update('environments', environment.id, { archived_at: new Date().toISOString() });
    res.json(store.find('environments', environment.id));
  });

  // -------------------------------------------------------------- sessions

  app.post('/v1/sessions', (req, res) => {
    const { agent, environment_id, title, initial_events } = req.body ?? {};
    const result = createSession({ agentRef: agent, environment_id, title, initial_events });
    if (result.error) {
      const [type, message, status] = result.error;
      return apiError(res, status, type, message);
    }
    res.json(result.session);
  });

  app.get('/v1/sessions', (req, res) => {
    let sessions = [...store.all('sessions')];
    if (req.query.agent_id) sessions = sessions.filter((s) => s.agent.id === req.query.agent_id);
    if (req.query.status) sessions = sessions.filter((s) => s.status === req.query.status);
    sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    res.json({ data: sessions.slice(0, limit) });
  });

  app.get('/v1/sessions/:id', (req, res) => {
    const session = store.find('sessions', req.params.id);
    if (!session) return apiError(res, 404, 'not_found_error', `session ${req.params.id} not found`);
    res.json(session);
  });

  app.get('/v1/sessions/:id/events', (req, res) => {
    const session = store.find('sessions', req.params.id);
    if (!session) return apiError(res, 404, 'not_found_error', `session ${req.params.id} not found`);
    res.json({ data: store.readEvents(session.id) });
  });

  app.post('/v1/sessions/:id/events', (req, res) => {
    const session = store.find('sessions', req.params.id);
    if (!session) return apiError(res, 404, 'not_found_error', `session ${req.params.id} not found`);
    const events = req.body?.events;
    if (!Array.isArray(events) || events.length === 0) {
      return apiError(res, 400, 'invalid_request_error', 'events must be a non-empty array');
    }
    for (const event of events) {
      if (!USER_EVENT_TYPES.has(event?.type)) {
        return apiError(res, 400, 'invalid_request_error',
          `event type ${event?.type ?? '(missing)'} is not a user event`);
      }
    }
    const appended = [];
    for (const event of events) {
      appended.push(appendAndSync(session, event));
      const fresh = store.find('sessions', session.id);
      if (event.type === 'user.message' && fresh.status === 'idle') {
        // New work re-queues the session for the next worker poll.
        store.update('sessions', session.id, { status: 'queued' });
      }
      if (event.type === 'user.interrupt' && fresh.status === 'queued') {
        appendAndSync(fresh, { type: 'session.status_terminated', stop_reason: 'interrupted' });
      }
    }
    res.json({ data: appended });
  });

  app.get('/v1/sessions/:id/stream', (req, res) => {
    const session = store.find('sessions', req.params.id);
    if (!session) return apiError(res, 404, 'not_found_error', `session ${req.params.id} not found`);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsubscribe = store.subscribe(session.id, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  // ----------------------------------------------------------- deployments

  app.post('/v1/deployments', (req, res) => {
    const { name, agent, environment_id, initial_events, schedule } = req.body ?? {};
    if (!name) return apiError(res, 400, 'invalid_request_error', 'name is required');
    const agentId = typeof agent === 'string' ? agent : agent?.id;
    if (!store.find('agents', agentId)) return apiError(res, 404, 'not_found_error', `agent ${agentId} not found`);
    if (!store.find('environments', environment_id)) {
      return apiError(res, 404, 'not_found_error', `environment ${environment_id} not found`);
    }
    if (!Array.isArray(initial_events) || !initial_events.some((e) => e?.type === 'user.message')) {
      return apiError(res, 400, 'invalid_request_error', 'initial_events must include a user.message event');
    }
    if (schedule?.type !== 'cron') return apiError(res, 400, 'invalid_request_error', 'schedule.type must be "cron"');
    const cronError = validateCron(schedule.expression ?? '');
    if (cronError) return apiError(res, 400, 'invalid_request_error', `invalid cron expression: ${cronError}`);
    const timezone = schedule.timezone ?? 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      return apiError(res, 400, 'invalid_request_error', `unknown timezone: ${timezone}`);
    }
    const now = new Date().toISOString();
    const next = nextRun(schedule.expression, timezone);
    const deployment = store.insert('deployments', {
      id: newDeploymentId(),
      type: 'deployment',
      name,
      agent: agentId,
      environment_id,
      initial_events,
      schedule: { type: 'cron', expression: schedule.expression, timezone, last_run_at: null },
      status: 'active',
      paused_reason: null,
      next_run_at: next ? next.toISOString() : null,
      created_at: now,
    });
    res.json(deploymentPublic(deployment));
  });

  app.get('/v1/deployments', (req, res) => {
    res.json({ data: store.all('deployments').map(deploymentPublic) });
  });

  app.get('/v1/deployments/:id', (req, res) => {
    const deployment = store.find('deployments', req.params.id);
    if (!deployment) return apiError(res, 404, 'not_found_error', `deployment ${req.params.id} not found`);
    res.json(deploymentPublic(deployment));
  });

  app.post('/v1/deployments/:id/pause', (req, res) => {
    const deployment = store.find('deployments', req.params.id);
    if (!deployment) return apiError(res, 404, 'not_found_error', `deployment ${req.params.id} not found`);
    if (deployment.status === 'archived') return apiError(res, 400, 'invalid_request_error', 'deployment is archived');
    store.update('deployments', deployment.id, {
      status: 'paused', paused_reason: { type: 'manual' }, next_run_at: null,
    });
    res.json(deploymentPublic(store.find('deployments', deployment.id)));
  });

  app.post('/v1/deployments/:id/unpause', (req, res) => {
    const deployment = store.find('deployments', req.params.id);
    if (!deployment) return apiError(res, 404, 'not_found_error', `deployment ${req.params.id} not found`);
    if (deployment.status === 'archived') return apiError(res, 400, 'invalid_request_error', 'deployment is archived');
    const next = nextRun(deployment.schedule.expression, deployment.schedule.timezone);
    store.update('deployments', deployment.id, {
      status: 'active', paused_reason: null, next_run_at: next ? next.toISOString() : null,
    });
    res.json(deploymentPublic(store.find('deployments', deployment.id)));
  });

  app.post('/v1/deployments/:id/archive', (req, res) => {
    const deployment = store.find('deployments', req.params.id);
    if (!deployment) return apiError(res, 404, 'not_found_error', `deployment ${req.params.id} not found`);
    store.update('deployments', deployment.id, { status: 'archived', next_run_at: null });
    res.json(deploymentPublic(store.find('deployments', deployment.id)));
  });

  app.post('/v1/deployments/:id/run', (req, res) => {
    const deployment = store.find('deployments', req.params.id);
    if (!deployment) return apiError(res, 404, 'not_found_error', `deployment ${req.params.id} not found`);
    if (deployment.status === 'archived') return apiError(res, 400, 'invalid_request_error', 'deployment is archived');
    const run = triggerDeployment(deployment, { type: 'manual' });
    res.json(run);
  });

  app.get('/v1/deployment_runs', (req, res) => {
    let runs = [...store.all('deployment_runs')];
    if (req.query.deployment_id) runs = runs.filter((r) => r.deployment_id === req.query.deployment_id);
    if (req.query.has_error === 'true') runs = runs.filter((r) => r.error);
    runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    res.json({ data: runs });
  });

  // Cron preview for the console's deployment form.
  app.get('/v1/cron_preview', (req, res) => {
    const { expression, timezone = 'UTC' } = req.query;
    const cronError = validateCron(expression ?? '');
    if (cronError) return apiError(res, 400, 'invalid_request_error', cronError);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      return apiError(res, 400, 'invalid_request_error', `unknown timezone: ${timezone}`);
    }
    res.json({ upcoming_runs_at: upcomingRuns(expression, timezone).map((d) => d.toISOString()) });
  });

  app.get('/v1/deployment_runs/:id', (req, res) => {
    const run = store.find('deployment_runs', req.params.id);
    if (!run) return apiError(res, 404, 'not_found_error', `deployment run ${req.params.id} not found`);
    res.json(run);
  });

  // --------------------------------------------------------- provider keys

  app.get('/v1/provider_keys', (req, res) => {
    res.json({ data: store.all('provider_keys').map(publicKey) });
  });

  app.post('/v1/provider_keys', (req, res) => {
    const { provider, name, value } = req.body ?? {};
    if (!PROVIDERS.has(provider)) {
      return apiError(res, 400, 'invalid_request_error', `provider must be one of: ${[...PROVIDERS].join(', ')}`);
    }
    if (!value || typeof value !== 'string' || value.length < 8) {
      return apiError(res, 400, 'invalid_request_error', 'value must be an API key string');
    }
    // One key per provider: replace on re-add.
    const existing = store.all('provider_keys').find((k) => k.provider === provider);
    if (existing) store.remove('provider_keys', existing.id);
    const key = store.insert('provider_keys', {
      id: newKeyId(),
      type: 'provider_key',
      provider,
      name: name ?? `${provider} key`,
      value,
      created_at: new Date().toISOString(),
      last_used_at: null,
    });
    res.json(publicKey(key));
  });

  app.delete('/v1/provider_keys/:id', (req, res) => {
    if (!store.remove('provider_keys', req.params.id)) {
      return apiError(res, 404, 'not_found_error', `key ${req.params.id} not found`);
    }
    res.json({ deleted: true });
  });

  // ------------------------------------------------- worker (internal) API
  // The Airflow-side runner uses these; they never reach the browser.

  app.post('/v1/internal/claim', (req, res) => {
    const { environment_id, worker_id } = req.body ?? {};
    if (environment_id) {
      const environment = store.find('environments', environment_id);
      if (environment) {
        store.update('environments', environment_id, {
          worker: { status: 'online', last_seen_at: new Date().toISOString(), worker_id: worker_id ?? null },
        });
      }
    }
    const queued = store.all('sessions')
      .filter((s) => s.status === 'queued' && (!environment_id || s.environment_id === environment_id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const session = queued[0];
    if (!session) return res.json({ session: null });
    appendAndSync(session, { type: 'session.status_running', worker_id: worker_id ?? null });
    const agent = resolveAgentVersion(session.agent.id, session.agent.version);
    const providerKey = store.all('provider_keys').find((k) => k.provider === agent?.model?.provider);
    if (providerKey) store.update('provider_keys', providerKey.id, { last_used_at: new Date().toISOString() });
    res.json({
      session: store.find('sessions', session.id),
      agent,
      events: store.readEvents(session.id),
      provider_key: providerKey ? { provider: providerKey.provider, value: providerKey.value } : null,
    });
  });

  app.post('/v1/internal/sessions/:id/events', (req, res) => {
    const session = store.find('sessions', req.params.id);
    if (!session) return apiError(res, 404, 'not_found_error', `session ${req.params.id} not found`);
    const events = req.body?.events;
    if (!Array.isArray(events) || events.length === 0) {
      return apiError(res, 400, 'invalid_request_error', 'events must be a non-empty array');
    }
    for (const event of events) {
      if (!WORKER_EVENT_TYPES.has(event?.type)) {
        return apiError(res, 400, 'invalid_request_error', `event type ${event?.type ?? '(missing)'} is not a worker event`);
      }
    }
    const appended = events.map((event) => appendAndSync(store.find('sessions', session.id), event));
    res.json({ data: appended });
  });

  app.get('/v1/internal/sessions/:id', (req, res) => {
    const session = store.find('sessions', req.params.id);
    if (!session) return apiError(res, 404, 'not_found_error', `session ${req.params.id} not found`);
    res.json(session);
  });

  // --------------------------------------------------------------- overview

  app.get('/v1/overview', (req, res) => {
    const sessions = store.all('sessions');
    const now = new Date();
    const dayMs = 86400000;
    const since7d = new Date(now.getTime() - 7 * dayMs);
    const recent7d = sessions.filter((s) => new Date(s.created_at) >= since7d);
    const finished = recent7d.filter((s) => s.status === 'idle' || s.status === 'terminated');
    const succeeded = finished.filter((s) => s.status === 'idle');
    const sessionHours = recent7d.reduce((sum, s) => {
      const end = s.status === 'running' || s.status === 'queued'
        ? now : new Date(s.updated_at ?? s.created_at);
      return sum + Math.max(0, (end - new Date(s.created_at)) / 3600000);
    }, 0);

    const perDay = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(now.getTime() - i * dayMs).toISOString().slice(0, 10);
      perDay.push({
        date: day,
        count: sessions.filter((s) => s.created_at.slice(0, 10) === day).length,
      });
    }

    const upcoming = store.all('deployments')
      .filter((d) => d.status === 'active')
      .flatMap((d) => {
        try {
          return upcomingRuns(d.schedule.expression, d.schedule.timezone, now, 2)
            .map((t) => ({ deployment_id: d.id, name: d.name, at: t.toISOString() }));
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, 5);

    res.json({
      active_sessions: sessions.filter((s) => s.status === 'running' || s.status === 'queued').length,
      sessions_today: sessions.filter((s) => s.created_at.slice(0, 10) === now.toISOString().slice(0, 10)).length,
      success_rate_7d: finished.length ? succeeded.length / finished.length : null,
      session_hours_7d: Math.round(sessionHours * 10) / 10,
      agents_count: store.all('agents').filter((a) => !a.archived_at).length,
      deployments_active: store.all('deployments').filter((d) => d.status === 'active').length,
      sessions_per_day: perDay,
      recent_sessions: [...sessions]
        .sort((a, b) => (b.last_event_at ?? b.created_at).localeCompare(a.last_event_at ?? a.created_at))
        .slice(0, 8),
      upcoming_runs: upcoming,
    });
  });

  // ------------------------------------------------------------ static SPA

  const webDist = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/v1\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  return app;
}
