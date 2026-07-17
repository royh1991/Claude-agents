// Gantry console server: a thin authoring + read layer over the
// credible-bi-airflow-triage backend package, plus a run proxy to Airflow.
//
// Platform constraints this server exists to respect (backend CLAUDE.md):
//   - Airflow orchestrates; this server never executes agents.
//   - Publishing writes files ONLY under agents/<id>/agent.yaml and
//     agent_triggers/<id>.yaml in the backend checkout. No commit/push.
//   - Secrets live in Vault. This server holds at most an Airflow API
//     credential (server-side env); the browser gets none of it.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveBackendPaths, loadCatalog, AGENT_ID_PATTERN,
} from './lib/catalog.mjs';
import {
  validateAgentConfig, generateAgentYaml,
  validateTriggerConfig, generateTriggerYaml,
} from './lib/agent_config.mjs';
import { validateSessionEnvelope, createRunAdapter, RESULT_STATUSES } from './lib/runs.mjs';
import { upcomingRuns, validateCron } from './lib/cron.mjs';

function apiError(res, status, type, message, details) {
  return res.status(status).json({ type: 'error', error: { type, message, details: details ?? null } });
}

export function createApp(env = process.env) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const paths = resolveBackendPaths(env);
  const catalog = () => loadCatalog(paths); // re-read per request: the repo is the database
  const runs = createRunAdapter(env, catalog);
  app.locals.runAdapter = runs;

  // ------------------------------------------------------------ catalog

  app.get('/api/catalog', (req, res) => {
    const cat = catalog();
    res.json({
      ...cat,
      run_mode: runs.mode,
      result_statuses: RESULT_STATUSES,
    });
  });

  app.get('/api/agents/:id', (req, res) => {
    const agent = catalog().agents.find((a) => a.id === req.params.id);
    if (!agent) return apiError(res, 404, 'not_found_error', `agent ${req.params.id} not found`);
    res.json(agent);
  });

  // --------------------------------------------------- authoring: agents

  app.post('/api/agents/preview', (req, res) => {
    const config = req.body?.config;
    const cat = catalog();
    const { problems, warnings } = validateAgentConfig(config, cat);
    let yaml = null;
    if (config && typeof config === 'object') {
      try {
        yaml = generateAgentYaml(config);
      } catch (err) {
        problems.push(`could not generate YAML: ${err.message}`);
      }
    }
    const existing = cat.agents.find((a) => a.id === config?.id) ?? null;
    res.json({
      yaml, problems, warnings,
      exists: Boolean(existing),
      existing_version: existing?.config?.version ?? null,
    });
  });

  app.post('/api/agents/publish', (req, res) => {
    const { config, overwrite } = req.body ?? {};
    const cat = catalog();
    const { problems, warnings } = validateAgentConfig(config, cat);
    if (problems.length) {
      return apiError(res, 400, 'invalid_config_error', 'the agent config has problems', problems);
    }
    // Path safety: id already matches AGENT_ID_PATTERN (validated above);
    // resolve and double-check containment anyway.
    const agentsRoot = path.join(paths.packageRoot, 'agents');
    const target = path.resolve(agentsRoot, config.id, 'agent.yaml');
    if (!target.startsWith(agentsRoot + path.sep)) {
      return apiError(res, 400, 'invalid_path_error', 'refusing to write outside agents/');
    }
    const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (previous !== null && !overwrite) {
      return apiError(res, 409, 'exists_error',
        `agents/${config.id}/agent.yaml already exists — pass overwrite to replace it`);
    }
    const yaml = generateAgentYaml(config);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, yaml);
    res.json({
      path: path.relative(paths.repoRoot, target),
      yaml,
      previous_yaml: previous,
      warnings,
      next_steps: 'Review the file in the backend checkout and open a PR — the console never commits or deploys.',
    });
  });

  // -------------------------------------------------- authoring: triggers

  app.post('/api/triggers/preview', (req, res) => {
    const config = req.body?.config;
    const { problems } = validateTriggerConfig(config, catalog());
    let yaml = null;
    if (config && typeof config === 'object') {
      try {
        yaml = generateTriggerYaml(config);
      } catch (err) {
        problems.push(`could not generate YAML: ${err.message}`);
      }
    }
    res.json({ yaml, problems });
  });

  app.post('/api/triggers/publish', (req, res) => {
    const { config, overwrite } = req.body ?? {};
    const { problems } = validateTriggerConfig(config, catalog());
    if (problems.length) {
      return apiError(res, 400, 'invalid_config_error', 'the trigger config has problems', problems);
    }
    const triggersRoot = path.join(paths.packageRoot, 'agent_triggers');
    const target = path.resolve(triggersRoot, `${config.id}.yaml`);
    if (!target.startsWith(triggersRoot + path.sep)) {
      return apiError(res, 400, 'invalid_path_error', 'refusing to write outside agent_triggers/');
    }
    const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (previous !== null && !overwrite) {
      return apiError(res, 409, 'exists_error',
        `agent_triggers/${config.id}.yaml already exists — pass overwrite to replace it`);
    }
    const yaml = generateTriggerYaml(config);
    fs.mkdirSync(triggersRoot, { recursive: true });
    fs.writeFileSync(target, yaml);
    res.json({
      path: path.relative(paths.repoRoot, target),
      yaml,
      previous_yaml: previous,
      next_steps: 'Trigger YAML is declarative config: wiring it into a real DAG is a separate, reviewed backend step.',
    });
  });

  // ------------------------------------------------------------- runs

  app.post('/api/runs', async (req, res) => {
    const envelope = req.body?.envelope;
    const problems = validateSessionEnvelope(envelope, catalog());
    if (problems.length) {
      return apiError(res, 400, 'invalid_envelope_error', 'the session envelope has problems', problems);
    }
    try {
      const out = await runs.trigger(envelope);
      res.json({ ...out, mode: runs.mode });
    } catch (err) {
      apiError(res, 502, 'airflow_error', String(err.message ?? err));
    }
  });

  app.get('/api/runs', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      res.json({ data: await runs.list(limit), mode: runs.mode });
    } catch (err) {
      apiError(res, 502, 'airflow_error', String(err.message ?? err));
    }
  });

  app.get('/api/runs/:dagRunId', async (req, res) => {
    try {
      const out = await runs.get(req.params.dagRunId);
      if (!out) return apiError(res, 404, 'not_found_error', `run ${req.params.dagRunId} not found`);
      res.json({ ...out, mode: runs.mode });
    } catch (err) {
      apiError(res, 502, 'airflow_error', String(err.message ?? err));
    }
  });

  // ----------------------------------------------------------- utilities

  app.get('/api/cron_preview', (req, res) => {
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

  app.get('/api/overview', async (req, res) => {
    const cat = catalog();
    let runList = [];
    let runsError = null;
    try {
      runList = await runs.list(100);
    } catch (err) {
      runsError = String(err.message ?? err);
    }
    const dayMs = 86400000;
    const now = Date.now();
    const last7 = runList.filter((r) => r.logical_date && now - new Date(r.logical_date).getTime() < 7 * dayMs);
    const finished = last7.filter((r) => r.state === 'success' || r.state === 'failed');
    res.json({
      agents_count: cat.agents.length,
      skills_count: cat.skills.length,
      tools_count: cat.tools.length,
      response_formats_count: cat.response_formats.length,
      triggers_count: cat.triggers.length,
      runs_7d: last7.length,
      green_rate_7d: finished.length
        ? finished.filter((r) => r.state === 'success').length / finished.length
        : null,
      active_runs: runList.filter((r) => r.state === 'running' || r.state === 'queued').length,
      recent_runs: runList.slice(0, 8),
      run_mode: runs.mode,
      runs_error: runsError,
      backend: cat.backend,
    });
  });

  // ---------------------------------------------------------- static SPA

  const webDist = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  return app;
}

export { AGENT_ID_PATTERN };
