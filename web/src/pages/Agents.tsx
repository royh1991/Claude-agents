import { Link, useNavigate } from 'react-router-dom';
import { useCatalog } from '../hooks';
import { ModelBadge, EmptyState } from '../components/bits';
import { modelId, toolName, skillId } from '../types';

export function Agents() {
  const { data: catalog, error } = useCatalog();
  const navigate = useNavigate();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <div className="sub">
            Each agent is a YAML pack in the backend repo — the model, system prompt,
            tools, skills, and output contract its runs use.
          </div>
        </div>
        <div className="actions">
          <Link to="/agents/new" className="btn primary">Create agent</Link>
        </div>
      </div>

      {error && <div className="alert error">Couldn't load the catalog: {error}</div>}
      <div className="card table-card">
        {catalog && catalog.agents.length === 0 ? (
          <EmptyState glyph="◈">
            No agent packs found under <span className="mono">agents/</span>.
            <Link to="/agents/new"> Create the first one</Link>.
          </EmptyState>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Model</th>
                <th>Version</th>
                <th>Skills</th>
                <th>Tools</th>
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {(catalog?.agents ?? []).map((agent) => (
                <tr key={agent.id} className="rowlink" onClick={() => navigate(`/agents/${agent.id}`)}>
                  <td>
                    <div className="primary">{agent.config?.name ?? agent.id}</div>
                    <div className="muted small">{agent.config?.description ?? agent.parse_error ?? ''}</div>
                  </td>
                  <td><ModelBadge id={modelId(agent.config?.model)} /></td>
                  <td className="mono muted">v{agent.config?.version ?? '?'}</td>
                  <td className="muted small">{(agent.config?.skills ?? []).map(skillId).join(', ') || '—'}</td>
                  <td className="muted small">{(agent.config?.tools ?? []).map(toolName).join(', ') || '—'}</td>
                  <td className="muted small">{String(agent.config?.metadata?.owner_team ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
