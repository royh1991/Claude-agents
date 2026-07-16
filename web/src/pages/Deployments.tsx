import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useFetch, useAgentIndex, useEnvironmentIndex } from '../hooks';
import type { Deployment, DeploymentRun, Environment } from '../types';
import { StatusChip, CopyId, EmptyState } from '../components/bits';
import { shortDateTime, timeUntil, timeAgo } from '../format';

export function Deployments() {
  const { data, error } = useFetch<{ data: Deployment[] }>('/v1/deployments', 20000);
  const agentIndex = useAgentIndex();
  const navigate = useNavigate();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Schedules</h1>
          <div className="sub">Deployments start sessions on a cron cadence. Each attempt is recorded as a run, success or failure.</div>
        </div>
        <div className="actions">
          <Link to="/deployments/new" className="btn primary">Create schedule</Link>
        </div>
      </div>

      {error && <div className="alert error">Couldn't load schedules: {error}</div>}
      <div className="card table-card">
        {data && data.data.length === 0 ? (
          <EmptyState glyph="◷">No schedules yet. <Link to="/deployments/new">Create one</Link> to run an agent on a cadence.</EmptyState>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Cadence</th>
                <th className="right">Next run</th>
              </tr>
            </thead>
            <tbody>
              {(data?.data ?? []).map((d) => (
                <tr key={d.id} className="rowlink" onClick={() => navigate(`/deployments/${d.id}`)}>
                  <td className="primary">{d.name}</td>
                  <td><StatusChip status={d.status} /></td>
                  <td className="muted">{agentIndex.get(d.agent)?.name ?? d.agent}</td>
                  <td><span className="mono small">{d.schedule.expression}</span> <span className="muted small">{d.schedule.timezone}</span></td>
                  <td className="right muted" title={d.schedule.upcoming_runs_at[0]}>
                    {d.schedule.upcoming_runs_at[0] ? timeUntil(d.schedule.upcoming_runs_at[0]) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function DeploymentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: deployment, reload } = useFetch<Deployment>(id ? `/v1/deployments/${id}` : null, 20000);
  const { data: runs, reload: reloadRuns } = useFetch<{ data: DeploymentRun[] }>(
    id ? `/v1/deployment_runs?deployment_id=${id}` : null, 20000);
  const agentIndex = useAgentIndex();
  const envIndex = useEnvironmentIndex();
  const [actionError, setActionError] = useState<string | null>(null);

  if (!deployment) return null;
  const prompt = deployment.initial_events.find((e) => e.type === 'user.message')?.content?.[0]?.text ?? '';

  async function act(verb: 'pause' | 'unpause' | 'archive' | 'run') {
    setActionError(null);
    if (verb === 'archive' && !window.confirm(`Archive ${deployment!.name}? The schedule stops permanently and can't be modified again.`)) return;
    try {
      await api.post(`/v1/deployments/${id}/${verb}`);
      reload();
      reloadRuns();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  return (
    <>
      <div className="crumbs"><Link to="/deployments">Schedules</Link> / {deployment.name}</div>
      <div className="page-head">
        <div>
          <h1>{deployment.name}</h1>
          <div className="sub" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
            <StatusChip status={deployment.status} />
            {deployment.paused_reason?.type === 'error' && (
              <span className="small" style={{ color: 'var(--bad)' }}>
                paused after {deployment.paused_reason.error?.type}
              </span>
            )}
          </div>
        </div>
        <div className="actions">
          {deployment.status !== 'archived' && (
            <>
              <button type="button" className="btn" onClick={() => act('run')}>Run now</button>
              {deployment.status === 'active'
                ? <button type="button" className="btn" onClick={() => act('pause')}>Pause</button>
                : <button type="button" className="btn" onClick={() => act('unpause')}>Resume</button>}
              <button type="button" className="btn danger" onClick={() => act('archive')}>Archive</button>
            </>
          )}
        </div>
      </div>

      {actionError && <div className="alert error">{actionError}</div>}

      <div className="grid cols-sidebar">
        <div>
          <div className="card">
            <h2>Task prompt</h2>
            <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>{prompt}</pre>
          </div>

          <div className="card table-card">
            <div className="card-head-row" style={{ padding: '10px 12px 0' }}>
              <h2>Run history</h2>
            </div>
            {(runs?.data ?? []).length === 0 ? (
              <EmptyState glyph="—">No runs yet. The first one fires {deployment.schedule.upcoming_runs_at[0] ? timeUntil(deployment.schedule.upcoming_runs_at[0]) : 'when the schedule resumes'}.</EmptyState>
            ) : (
              <table className="list">
                <thead>
                  <tr><th>Fired</th><th>Trigger</th><th>Outcome</th></tr>
                </thead>
                <tbody>
                  {(runs?.data ?? []).map((run) => (
                    <tr key={run.id} className={run.session_id ? 'rowlink' : ''}
                      onClick={() => run.session_id && navigate(`/sessions/${run.session_id}`)}>
                      <td title={run.created_at}>{timeAgo(run.created_at)}</td>
                      <td className="muted">{run.trigger_context.type}</td>
                      <td>
                        {run.session_id
                          ? <span className="small">session started — <span className="mono">{run.session_id.slice(0, 14)}…</span></span>
                          : <span className="small" style={{ color: 'var(--bad)' }}>
                              <span className="mono">{run.error?.type}</span> — {run.error?.message}
                            </span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="card">
          <h2>Schedule</h2>
          <dl className="kv">
            <dt>Cron</dt><dd className="mono">{deployment.schedule.expression}</dd>
            <dt>Timezone</dt><dd>{deployment.schedule.timezone}</dd>
            <dt>Agent</dt>
            <dd><Link to={`/agents/${deployment.agent}`}>{agentIndex.get(deployment.agent)?.name ?? deployment.agent}</Link></dd>
            <dt>Environment</dt>
            <dd><Link to={`/environments/${deployment.environment_id}`}>{envIndex.get(deployment.environment_id) ?? deployment.environment_id}</Link></dd>
            <dt>Last run</dt><dd>{deployment.schedule.last_run_at ? timeAgo(deployment.schedule.last_run_at) : 'never'}</dd>
            <dt>Schedule ID</dt><dd><CopyId id={deployment.id} /></dd>
          </dl>
          {deployment.schedule.upcoming_runs_at.length > 0 && (
            <>
              <hr className="rule" />
              <h2>Upcoming</h2>
              {deployment.schedule.upcoming_runs_at.map((at) => (
                <div key={at} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13 }}>
                  <span>{shortDateTime(at)}</span>
                  <span className="muted small">{timeUntil(at)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function DeploymentForm() {
  const navigate = useNavigate();
  const agentIndex = useAgentIndex();
  const { data: environments } = useFetch<{ data: Environment[] }>('/v1/environments');

  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [expression, setExpression] = useState('0 6 * * *');
  const [timezone, setTimezone] = useState('America/New_York');
  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api.get<{ upcoming_runs_at: string[] }>(
        `/v1/cron_preview?expression=${encodeURIComponent(expression)}&timezone=${encodeURIComponent(timezone)}`)
        .then((r) => { setPreview(r.upcoming_runs_at); setPreviewError(null); })
        .catch((e: Error) => { setPreview(null); setPreviewError(e.message); });
    }, 300);
    return () => clearTimeout(t);
  }, [expression, timezone]);

  async function create() {
    setError(null);
    if (!name.trim() || !prompt.trim()) { setError('Name and task prompt are both required.'); return; }
    const agent = agentId || [...agentIndex.keys()][0];
    const env = environmentId || environments?.data.find((e) => !e.archived_at)?.id;
    if (!agent || !env) { setError('Pick an agent and an environment.'); return; }
    try {
      const deployment = await api.post<Deployment>('/v1/deployments', {
        name: name.trim(),
        agent,
        environment_id: env,
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: prompt.trim() }] }],
        schedule: { type: 'cron', expression, timezone },
      });
      navigate(`/deployments/${deployment.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="crumbs"><Link to="/deployments">Schedules</Link> / New</div>
      <div className="page-head">
        <div>
          <h1>Create schedule</h1>
          <div className="sub">Run an agent on a cadence. Each firing queues a session that an Airflow worker picks up.</div>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <div className="field">
          <label htmlFor="d-name">Name</label>
          <input id="d-name" type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Nightly table QA sweep" />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="d-agent">Agent</label>
            <select id="d-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {[...agentIndex.entries()].map(([aid, a]) => <option key={aid} value={aid}>{a.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="d-env">Environment</label>
            <select id="d-env" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
              {(environments?.data ?? []).filter((e) => !e.archived_at).map((env) => (
                <option key={env.id} value={env.id}>{env.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="d-prompt">Task prompt — the first message of every session</label>
          <textarea id="d-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="Run the nightly quality checks for the core mart tables (manifest: qa/core_marts.yml)." />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="d-cron">Cron expression</label>
            <input id="d-cron" type="text" className="mono" value={expression}
              onChange={(e) => setExpression(e.target.value)} placeholder="0 6 * * *" />
            <div className="help">POSIX cron: minute hour day-of-month month day-of-week.</div>
          </div>
          <div className="field">
            <label htmlFor="d-tz">Timezone</label>
            <input id="d-tz" type="text" value={timezone} onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/New_York" />
            <div className="help">IANA identifier; wall-clock matching across DST.</div>
          </div>
        </div>

        {previewError
          ? <div className="alert error">{previewError}</div>
          : preview && (
            <div className="alert info">
              Next runs: {preview.map((at) => shortDateTime(at)).join('  ·  ')}
            </div>
          )}

        <div className="form-actions">
          <button type="button" className="btn primary" onClick={create}>Create schedule</button>
          <Link to="/deployments" className="btn">Cancel</Link>
        </div>
      </div>
    </>
  );
}
