import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, describeError } from '../api';
import { useCatalog } from '../hooks';
import { ModelBadge, SchemaTable, StatusChip, CopyId } from '../components/bits';
import { modelId, toolName, skillId } from '../types';
import type { SessionEnvelope } from '../types';

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: catalog } = useCatalog();
  const [showYaml, setShowYaml] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [format, setFormat] = useState<string | null>(null);
  const [repoMode, setRepoMode] = useState<'default' | 'custom' | 'none'>('default');
  const [aliases, setAliases] = useState('');
  const [metadataText, setMetadataText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!catalog) return null;
  const agent = catalog.agents.find((a) => a.id === id);
  if (!agent) return <div className="alert error">Agent {id} not found in the catalog.</div>;
  const config = agent.config;
  const responseFormat = format ?? config?.response_format ?? '';
  const defaultAliases = (config?.metadata?.default_repository_aliases ?? []).join(', ');
  const schema = catalog.response_formats.find((f) => f.name === (config?.response_format ?? ''))?.schema ?? null;

  async function startRun() {
    if (!config) return;
    setFormError(null);
    if (!message.trim()) { setFormError('Describe the work in the message — it becomes the session\'s user.message event.'); return; }
    let metadata: Record<string, unknown> | undefined;
    if (metadataText.trim()) {
      try {
        metadata = JSON.parse(metadataText);
      } catch {
        setFormError('Metadata must be valid JSON (an object of run context, e.g. {"dbt_asset": "fct_orders"}).');
        return;
      }
    }
    const envelope: SessionEnvelope = {
      type: 'session',
      agent: { type: 'agent', id: config.id, version: config.version },
      environment_id: 'airflow-triage-runtime',
      title: title.trim() || null,
      metadata,
      events: [{ type: 'user.message', content: [{ type: 'text', text: message.trim() }] }],
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };
    // Contract: omitting `resources` uses the agent's defaults, while an
    // explicit [] means clone nothing — so only include the key when the
    // user overrode the default behavior.
    if (repoMode === 'none') {
      envelope.resources = [];
    } else if (repoMode === 'custom') {
      envelope.resources = aliases.split(',').map((s) => s.trim()).filter(Boolean)
        .map((alias) => ({ type: 'repository_alias', alias }));
    }
    setSubmitting(true);
    try {
      const out = await api.post<{ dag_run_id: string }>('/api/runs', { envelope });
      navigate(`/runs/${encodeURIComponent(out.dag_run_id)}`);
    } catch (e) {
      setFormError(describeError(e));
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="crumbs"><Link to="/agents">Agents</Link> / {config?.name ?? agent.id}</div>
      <div className="page-head">
        <div>
          <h1>{config?.name ?? agent.id}</h1>
          <div className="sub">{config?.description}</div>
        </div>
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => setRunOpen((v) => !v)}>Run agent</button>
          <Link to={`/agents/${agent.id}/edit`} className="btn">Edit</Link>
          <button type="button" className="btn" onClick={() => setShowYaml((v) => !v)}>
            {showYaml ? 'Hide YAML' : 'View YAML'}
          </button>
        </div>
      </div>

      {agent.parse_error && <div className="alert error">agent.yaml failed to parse: {agent.parse_error}</div>}
      {agent.dir_mismatch && <div className="alert error">{agent.dir_mismatch}</div>}

      {runOpen && config && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Run this agent</h2>
          {formError && <div className="alert error">{formError}</div>}
          <div className="form-row">
            <div className="field">
              <label htmlFor="r-title">Title (optional)</label>
              <input id="r-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="ad-hoc: fct_orders revenue check" />
            </div>
            <div className="field">
              <label htmlFor="r-format">Response format</label>
              <select id="r-format" value={responseFormat} onChange={(e) => setFormat(e.target.value)}>
                {catalog.response_formats.map((f) => (
                  <option key={f.name} value={f.name}>{f.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="r-msg">Message — the work to do</label>
            <textarea id="r-msg" value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder="Inspect recent daily behavior of fct_orders at day grain…" />
            <div className="help">Sent as the session's <span className="mono">user.message</span> event.</div>
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="r-repos">Repositories to clone</label>
              <select id="r-repos" value={repoMode}
                onChange={(e) => setRepoMode(e.target.value as typeof repoMode)}>
                <option value="default">
                  Agent default — {config.metadata?.include_all_repository_aliases_by_default
                    ? 'all catalog repositories'
                    : defaultAliases || 'none'}
                </option>
                <option value="custom">A custom list</option>
                <option value="none">None — clone nothing</option>
              </select>
              {repoMode === 'custom' && (
                <input type="text" className="mono" style={{ marginTop: 8 }} value={aliases}
                  onChange={(e) => setAliases(e.target.value)}
                  placeholder="credible-dbt, airflow-utils"
                  aria-label="Repository aliases, comma-separated" />
              )}
              <div className="help">Aliases must exist in the repository catalog Airflow passes to the pod.</div>
            </div>
            <div className="field">
              <label htmlFor="r-meta">Metadata (JSON, optional)</label>
              <input id="r-meta" type="text" className="mono" value={metadataText}
                onChange={(e) => setMetadataText(e.target.value)}
                placeholder='{"dbt_asset": "fct_orders", "grain": "day"}' />
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={startRun} disabled={submitting}>
              {submitting ? 'Triggering…' : `Trigger ${catalog.run_mode === 'mock' ? 'mock ' : ''}run`}
            </button>
            <button type="button" className="btn" onClick={() => setRunOpen(false)}>Cancel</button>
            <span className="muted small">
              Creates a dag run of <span className="mono">ai-agent-runner</span>
              {catalog.run_mode === 'mock' ? ' (simulated — no Airflow configured)' : ''}.
            </span>
          </div>
        </div>
      )}

      {showYaml && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head-row">
            <h2>{agent.path}</h2>
            <CopyId id={agent.raw} />
          </div>
          <pre className="code">{agent.raw}</pre>
        </div>
      )}

      <div className="grid cols-sidebar">
        <div>
          <div className="card">
            <h2>System prompt</h2>
            <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>{config?.system ?? '(none)'}</pre>
          </div>

          <div className="card">
            <h2>Output contract — {config?.response_format ?? 'none'}</h2>
            <SchemaTable schema={schema} />
            <div className="help" style={{ marginTop: 8 }}>
              The runtime injects this schema into the prompt and validates the model's
              output against it; runs whose output doesn't match fail as
              <span className="mono"> invalid_output</span>.
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Configuration</h2>
            <dl className="kv">
              <dt>Model</dt><dd><ModelBadge id={modelId(config?.model)} /></dd>
              <dt>Version</dt><dd className="mono">v{config?.version}</dd>
              <dt>Agent ID</dt><dd><CopyId id={agent.id} /></dd>
              <dt>Owner</dt><dd>{String(config?.metadata?.owner_team ?? '—')}</dd>
              <dt>Repos</dt>
              <dd className="small">
                {config?.metadata?.include_all_repository_aliases_by_default
                  ? 'all catalog repositories'
                  : (config?.metadata?.default_repository_aliases ?? []).join(', ') || 'none by default'}
              </dd>
              <dt>Notify</dt>
              <dd className="small">{(config?.metadata?.notification_defaults ?? []).map((n) => n.type).join(', ') || '—'}</dd>
            </dl>
          </div>

          <div className="card">
            <h2>Skills</h2>
            {(config?.skills ?? []).map((s) => {
              const sid = skillId(s);
              return <div key={sid} style={{ padding: '4px 0' }}><Link to={`/library#skill-${sid}`}>{sid}</Link></div>;
            })}
            {(config?.skills ?? []).length === 0 && <div className="muted small">No skills attached.</div>}
          </div>

          <div className="card">
            <h2>Tools</h2>
            {(config?.tools ?? []).map((t) => {
              const name = toolName(t);
              return (
                <div key={name} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                  <Link to={`/library#tool-${name}`} className="mono small">{name}</Link>
                  <StatusChip status="active" />
                </div>
              );
            })}
            {(config?.tools ?? []).length === 0 && <div className="muted small">No custom tools.</div>}
          </div>
        </div>
      </div>
    </>
  );
}
