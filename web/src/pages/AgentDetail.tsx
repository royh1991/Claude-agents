import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useFetch, useAgentIndex, useEnvironmentIndex } from '../hooks';
import type { Agent, Environment, Session } from '../types';
import { ModelBadge, CopyId } from '../components/bits';
import { SessionTable } from '../components/SessionTable';
import { shortDateTime } from '../format';

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: agent } = useFetch<Agent>(id ? `/v1/agents/${id}` : null);
  const { data: versions } = useFetch<{ data: Agent[] }>(id ? `/v1/agents/${id}/versions` : null);
  const { data: sessions } = useFetch<{ data: Session[] }>(id ? `/v1/sessions?agent_id=${id}&limit=10` : null);
  const { data: environments } = useFetch<{ data: Environment[] }>('/v1/environments');
  const agentIndex = useAgentIndex();
  const envIndex = useEnvironmentIndex();

  const [starting, setStarting] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  if (!agent) return null;
  const activeEnvs = (environments?.data ?? []).filter((e) => !e.archived_at);

  async function startSession() {
    if (!message.trim()) { setFormError('Describe the work in the first message.'); return; }
    const envId = environmentId || activeEnvs[0]?.id;
    if (!envId) { setFormError('Create an environment first.'); return; }
    try {
      const session = await api.post<Session>('/v1/sessions', {
        agent: agent!.id,
        environment_id: envId,
        title: title.trim() || null,
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: message.trim() }] }],
      });
      navigate(`/sessions/${session.id}`);
    } catch (e) {
      setFormError((e as Error).message);
    }
  }

  async function archive() {
    if (!window.confirm(`Archive ${agent!.name}? The agent becomes read-only and new sessions can't reference it. This can't be undone.`)) return;
    await api.post(`/v1/agents/${agent!.id}/archive`);
    navigate('/agents');
  }

  return (
    <>
      <div className="crumbs"><Link to="/agents">Agents</Link> / {agent.name}</div>
      <div className="page-head">
        <div>
          <h1>{agent.name}{agent.archived_at && <span className="muted"> (archived)</span>}</h1>
          <div className="sub">{agent.description}</div>
        </div>
        <div className="actions">
          {!agent.archived_at && (
            <>
              <button type="button" className="btn" onClick={() => setStarting((s) => !s)}>Start session</button>
              <Link to={`/agents/${agent.id}/edit`} className="btn">Edit</Link>
              <button type="button" className="btn danger" onClick={archive}>Archive</button>
            </>
          )}
        </div>
      </div>

      {starting && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Start a session</h2>
          {formError && <div className="alert error">{formError}</div>}
          <div className="form-row">
            <div className="field">
              <label htmlFor="s-title">Title (optional)</label>
              <input id="s-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="Triage: dw_core_load failed at …" />
            </div>
            <div className="field">
              <label htmlFor="s-env">Environment</label>
              <select id="s-env" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
                {activeEnvs.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="s-msg">First message — the work to do</label>
            <textarea id="s-msg" value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder="Diagnose the failure of DAG …" />
            <div className="help">The session queues until an Airflow worker in the chosen environment claims it.</div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={startSession}>Queue session</button>
            <button type="button" className="btn" onClick={() => setStarting(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="grid cols-sidebar">
        <div>
          <div className="card">
            <h2>System prompt</h2>
            <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>{agent.system ?? '(none)'}</pre>
          </div>

          <div className="card">
            <h2>Connections</h2>
            {agent.tools.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div className="io-label muted small" style={{ marginBottom: 6 }}>Toolset</div>
                {agent.tools.map((tool, i) => (
                  <span key={i} className="badge" style={{ marginRight: 6 }}>
                    {tool.type}
                    {tool.config && `: ${Object.entries(tool.config).filter(([, v]) => v).map(([k]) => k).join(', ')}`}
                  </span>
                ))}
              </div>
            )}
            {agent.mcp_servers.length === 0
              ? <div className="muted small">No MCP servers attached.</div>
              : (
                <table className="list">
                  <thead><tr><th>MCP server</th><th>Tools</th><th>Endpoint</th></tr></thead>
                  <tbody>
                    {agent.mcp_servers.map((server) => (
                      <tr key={server.name}>
                        <td className="primary">{server.name}</td>
                        <td className="muted small">{server.tools.join(', ')}</td>
                        <td className="mono muted small">{server.url}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>

          <div className="card table-card">
            <div className="card-head-row" style={{ padding: '10px 12px 0' }}>
              <h2>Recent sessions</h2>
              <Link to="/sessions" className="small">View all</Link>
            </div>
            <SessionTable sessions={sessions?.data ?? []} agentIndex={agentIndex} showAgent={false} />
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Configuration</h2>
            <dl className="kv">
              <dt>Model</dt><dd><ModelBadge model={agent.model} /></dd>
              <dt>Provider</dt><dd>{agent.model.provider}</dd>
              <dt>Version</dt><dd className="mono">v{agent.version}</dd>
              <dt>Created</dt><dd>{shortDateTime(agent.created_at)}</dd>
              <dt>Updated</dt><dd>{shortDateTime(agent.updated_at)}</dd>
              <dt>Agent ID</dt><dd><CopyId id={agent.id} /></dd>
              {Object.entries(agent.metadata).map(([k, v]) => (
                <><dt key={k}>{k}</dt><dd key={`${k}-v`}>{String(v)}</dd></>
              ))}
            </dl>
          </div>

          <div className="card">
            <h2>Version history</h2>
            {(versions?.data ?? []).map((v) => (
              <div key={v.version}
                style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line-2)', fontSize: 13 }}>
                <span className="mono">v{v.version}{v.version === agent.version && <span className="muted"> · current</span>}</span>
                <span className="muted small">{shortDateTime(v.updated_at)}</span>
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Environments</h2>
            <div className="muted small">
              Sessions for this agent can run in{' '}
              {[...envIndex.values()].join(', ') || 'no environments yet'}.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
