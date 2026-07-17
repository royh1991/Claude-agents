import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, describeError } from '../api';
import { useFetch, useCatalog } from '../hooks';
import type { RunDetail as RunDetailData } from '../types';
import { StatusChip, CopyId } from '../components/bits';
import { Pipeline, ResultView } from '../components/RunBits';
import { shortDateTime, duration } from '../format';

export function RunDetail() {
  const { dagRunId } = useParams<{ dagRunId: string }>();
  const navigate = useNavigate();
  const active = (state?: string) => state === 'queued' || state === 'running';
  const [rerunError, setRerunError] = useState<string | null>(null);
  const { data, error } = useFetch<RunDetailData>(
    dagRunId ? `/api/runs/${encodeURIComponent(dagRunId)}` : null, 3000);
  const { data: catalog } = useCatalog();

  // Only hard-fail when we have nothing to show; a transient poll error
  // must not blank a page that already has data.
  if (error && !data) return <div className="alert error">Couldn't load the run: {error}</div>;
  if (!data || !catalog) return null;
  const { run, tasks, result } = data;
  const agent = catalog.agents.find((a) => a.id === run.agent_id);
  const formatName = run.response_format ?? agent?.config?.response_format ?? null;
  const schema = catalog.response_formats.find((f) => f.name === formatName)?.schema ?? null;

  async function rerun() {
    setRerunError(null);
    try {
      // Re-pin to the agent's *current* version: the original conf pins the
      // version at submission time, which the backend rejects after a bump.
      const envelope = { ...run.conf } as Record<string, unknown> & { agent?: { id: string; version?: number } };
      if (envelope.agent) {
        envelope.agent = { ...envelope.agent };
        const current = agent?.config?.version;
        if (current != null) envelope.agent.version = current;
        else delete envelope.agent.version;
      }
      const out = await api.post<{ dag_run_id: string }>('/api/runs', { envelope });
      navigate(`/runs/${encodeURIComponent(out.dag_run_id)}`);
    } catch (e) {
      setRerunError(describeError(e));
    }
  }

  return (
    <>
      <div className="crumbs"><Link to="/runs">Runs</Link> / <span className="mono">{run.dag_run_id.slice(0, 40)}</span></div>
      <div className="page-head">
        <div>
          <h1>{run.title ?? run.dag_run_id}</h1>
          <div className="sub" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
            <StatusChip status={run.state} />
            {result && result.status !== 'success' && <StatusChip status={result.status} />}
            <span className="muted small">started {shortDateTime(run.start_date)}</span>
          </div>
        </div>
        <div className="actions">
          {!active(run.state) && (
            <button type="button" className="btn" onClick={rerun}>Run again</button>
          )}
        </div>
      </div>

      {rerunError && <div className="alert error">{rerunError}</div>}

      <div className="card">
        <h2>Pipeline — ai-agent-runner</h2>
        <Pipeline tasks={tasks} />
        {run.state === 'failed' && result?.status !== 'success' && result && (
          <div className="help" style={{ marginTop: 10 }}>
            <span className="mono">run-agent</span> exited cleanly with a structured
            <span className="mono"> {result.status}</span> result;
            <span className="mono"> evaluate-result</span> turned it red. That's the expected failure path.
          </div>
        )}
      </div>

      <div className="grid cols-sidebar" style={{ marginTop: 16 }}>
        <div>
          {result?.error && (
            <div className="alert error" style={{ marginBottom: 16 }}>
              <strong className="mono">{result.error.code}</strong><br />
              {result.error.message}
            </div>
          )}

          {result?.result && (
            <div className="card">
              <div className="card-head-row">
                <h2>Result{formatName ? ` — ${formatName}` : ''}</h2>
                <StatusChip status={result.status} />
              </div>
              <ResultView result={result} schema={schema} />
            </div>
          )}

          {!result && active(run.state) && (
            <div className="card">
              <div className="live-foot">
                <span className="pulse" aria-hidden />
                The agent pod is working — the structured result lands when
                <span className="mono">run-agent</span> finishes.
              </div>
            </div>
          )}

          {result?.raw_output ? (
            <div className="card">
              <details>
                <summary className="small muted" style={{ cursor: 'pointer' }}>Raw model output (truncated at 20k chars)</summary>
                <pre className="code" style={{ marginTop: 10 }}>{result.raw_output}</pre>
              </details>
            </div>
          ) : null}

          <div className="card">
            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>Request envelope (dag_run.conf)</summary>
              <pre className="code" style={{ marginTop: 10 }}>{JSON.stringify(run.conf, null, 2)}</pre>
            </details>
          </div>
        </div>

        <div className="card">
          <h2>Details</h2>
          <dl className="kv">
            <dt>Agent</dt>
            <dd>
              {agent
                ? <Link to={`/agents/${agent.id}`}>{agent.config?.name ?? agent.id}</Link>
                : run.agent_id ?? '—'}
              {result && <span className="muted"> · v{result.agent_version}</span>}
            </dd>
            <dt>Provider</dt><dd className="mono small">{result?.provider.kind ?? 'gemini-cli'}</dd>
            <dt>Environment</dt><dd className="mono small">{result?.environment_id ?? String(run.conf.environment_id ?? 'airflow-triage-runtime')}</dd>
            <dt>Duration</dt><dd>{run.start_date ? duration(run.start_date, run.end_date) : '—'}</dd>
            {result?.session_id && (<><dt>Session</dt><dd><CopyId id={result.session_id} /></dd></>)}
            <dt>Dag run</dt><dd><CopyId id={run.dag_run_id} /></dd>
          </dl>
          {result?.resource_context && result.resource_context.repositories.length > 0 && (
            <>
              <hr className="rule" />
              <h2>Workspace</h2>
              {result.resource_context.repositories.map((repo) => (
                <div key={repo.alias} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                  <span className="mono small">{repo.alias}</span>
                  <span className="muted small">{repo.path}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}
