import { Link, useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks';
import type { Agent } from '../types';
import { ModelBadge, EmptyState } from '../components/bits';
import { timeAgo } from '../format';

export function Agents() {
  const { data, error } = useFetch<{ data: Agent[] }>('/v1/agents');
  const navigate = useNavigate();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <div className="sub">Reusable, versioned configurations: the model, system prompt, and connections each session runs with.</div>
        </div>
        <div className="actions">
          <Link to="/agents/new" className="btn primary">Create agent</Link>
        </div>
      </div>

      {error && <div className="alert error">Couldn't load agents: {error}</div>}
      <div className="card table-card">
        {data && data.data.length === 0 ? (
          <EmptyState glyph="◈">
            No agents yet. <Link to="/agents/new">Create your first agent</Link> to define what it does and which connections it can use.
          </EmptyState>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Name</th>
                <th>Model</th>
                <th>Version</th>
                <th>Connections</th>
                <th className="right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {(data?.data ?? []).map((agent) => (
                <tr key={agent.id} className="rowlink" onClick={() => navigate(`/agents/${agent.id}`)}>
                  <td>
                    <div className="primary">{agent.name}</div>
                    <div className="muted small">{agent.description}</div>
                  </td>
                  <td><ModelBadge model={agent.model} /></td>
                  <td className="mono muted">v{agent.version}</td>
                  <td className="muted small">
                    {agent.mcp_servers.map((s) => s.name).join(', ') || '—'}
                  </td>
                  <td className="right muted" title={agent.updated_at}>{timeAgo(agent.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
