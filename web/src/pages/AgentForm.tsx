import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { Agent, McpServer } from '../types';

const MODELS: { id: string; provider: string; label: string }[] = [
  { id: 'gemini-2.5-pro', provider: 'google', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', provider: 'google', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.0-flash', provider: 'google', label: 'Gemini 2.0 Flash' },
  { id: 'claude-opus-4-8', provider: 'anthropic', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Claude Sonnet 5' },
  { id: 'gpt-5.2', provider: 'openai', label: 'GPT-5.2' },
];

const CONNECTIONS: { name: string; url: string; tools: string[]; desc: string }[] = [
  { name: 'snowflake', url: 'https://mcp.internal/snowflake', tools: ['query', 'query_history'], desc: 'Read-only warehouse access (role AGENT_RO)' },
  { name: 's3', url: 'https://mcp.internal/s3', tools: ['get_object', 'list_objects'], desc: 'Data lake and Airflow logs, read-only' },
  { name: 'github', url: 'https://mcp.internal/github', tools: ['create_issue', 'create_pull_request'], desc: 'Issues and PRs on data-platform repos' },
  { name: 'dbt', url: 'https://mcp.internal/dbt', tools: ['run_tests', 'compile'], desc: 'dbt Cloud jobs and test runs' },
];

const TOOLSET = [
  { key: 'bash', label: 'Bash', desc: 'Run shell commands in the worker pod' },
  { key: 'file_operations', label: 'File operations', desc: 'Read, write, and edit files in the workspace' },
  { key: 'web_search', label: 'Web search', desc: 'Search and fetch from the public web (egress-controlled)' },
];

export function AgentForm() {
  const { id } = useParams<{ id?: string }>();
  const editing = Boolean(id);
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [modelId, setModelId] = useState(MODELS[0].id);
  const [system, setSystem] = useState('');
  const [toolset, setToolset] = useState<Record<string, boolean>>({ bash: true, file_operations: true, web_search: false });
  const [connections, setConnections] = useState<Record<string, boolean>>({});
  const [version, setVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.get<Agent>(`/v1/agents/${id}`).then((agent) => {
      setName(agent.name);
      setDescription(agent.description ?? '');
      setModelId(agent.model.id);
      setSystem(agent.system ?? '');
      setVersion(agent.version);
      const ts = agent.tools.find((t) => t.type === 'agent_toolset');
      if (ts?.config) setToolset({ bash: false, file_operations: false, web_search: false, ...ts.config });
      const conns: Record<string, boolean> = {};
      for (const server of agent.mcp_servers) conns[server.name] = true;
      setConnections(conns);
    }).catch((e: Error) => setError(e.message));
  }, [id]);

  async function save() {
    setError(null);
    if (!name.trim()) { setError('Give the agent a name.'); return; }
    setSaving(true);
    const mcp_servers: McpServer[] = CONNECTIONS
      .filter((c) => connections[c.name])
      .map(({ name: n, url, tools }) => ({ name: n, url, tools }));
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      model: modelId,
      system: system.trim() || null,
      tools: [{ type: 'agent_toolset', config: toolset }],
      mcp_servers,
    };
    try {
      const saved = editing
        ? await api.post<Agent>(`/v1/agents/${id}`, { version, ...body })
        : await api.post<Agent>('/v1/agents', body);
      navigate(`/agents/${saved.id}`);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <>
      <div className="crumbs"><Link to="/agents">Agents</Link> / {editing ? 'Edit' : 'New'}</div>
      <div className="page-head">
        <div>
          <h1>{editing ? `Edit agent` : 'Create agent'}</h1>
          <div className="sub">
            {editing
              ? `Saving creates version ${version != null ? version + 1 : '…'}; running sessions keep the version they started with.`
              : 'Define what this agent does and which connections its sessions can reach.'}
          </div>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <div className="form-row">
          <div className="field">
            <label htmlFor="a-name">Name</label>
            <input id="a-name" type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Pipeline triage" />
          </div>
          <div className="field">
            <label htmlFor="a-model">Model</label>
            <select id="a-model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
              {['google', 'anthropic', 'openai'].map((provider) => (
                <optgroup key={provider} label={provider === 'google' ? 'Google (gemini-cli harness)' : provider}>
                  {MODELS.filter((m) => m.provider === provider).map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="help">Runs with the provider key from Model providers. The current harness executes Google models via gemini-cli.</div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="a-desc">Description</label>
          <input id="a-desc" type="text" value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Diagnoses failed Airflow DAG runs and files issues with a root-cause writeup." />
        </div>

        <div className="field">
          <label htmlFor="a-system">System prompt</label>
          <textarea id="a-system" className="mono" rows={7} value={system}
            onChange={(e) => setSystem(e.target.value)}
            placeholder="You are an on-call data platform engineer…" />
          <div className="help">Defines behavior and persona. Describe the work itself in each session's first message instead.</div>
        </div>

        <div className="form-row">
          <div className="field">
            <label>Toolset</label>
            {TOOLSET.map((tool) => (
              <label key={tool.key} className="check-row">
                <input type="checkbox" checked={Boolean(toolset[tool.key])}
                  onChange={(e) => setToolset({ ...toolset, [tool.key]: e.target.checked })} />
                {tool.label}
                <span className="desc">— {tool.desc}</span>
              </label>
            ))}
          </div>
          <div className="field">
            <label>Connections (MCP)</label>
            {CONNECTIONS.map((conn) => (
              <label key={conn.name} className="check-row">
                <input type="checkbox" checked={Boolean(connections[conn.name])}
                  onChange={(e) => setConnections({ ...connections, [conn.name]: e.target.checked })} />
                {conn.name}
                <span className="desc">— {conn.desc}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="form-actions">
          <button type="button" className="btn primary" onClick={save} disabled={saving}>
            {editing ? 'Save new version' : 'Create agent'}
          </button>
          <Link to={editing ? `/agents/${id}` : '/agents'} className="btn">Cancel</Link>
        </div>
      </div>
    </>
  );
}
