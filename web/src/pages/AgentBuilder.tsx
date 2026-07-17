import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, describeError } from '../api';
import { useCatalog } from '../hooks';
import type { AgentConfig, AgentPreview, PublishResult } from '../types';
import { modelId, toolName, skillId } from '../types';

const MODEL_CHOICES = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];

interface FormState {
  id: string;
  version: number;
  name: string;
  description: string;
  model: string;
  system: string;
  tools: string[];
  skills: string[];
  response_format: string;
  owner_team: string;
  repo_mode: 'none' | 'defaults' | 'all';
  default_aliases: string;
  notify_slack: boolean;
}

const BLANK: FormState = {
  id: '', version: 1, name: '', description: '', model: MODEL_CHOICES[0],
  system: '', tools: [], skills: [], response_format: '',
  owner_team: '', repo_mode: 'none', default_aliases: '', notify_slack: true,
};

function fromConfig(config: AgentConfig): FormState {
  const metadata = config.metadata ?? {};
  return {
    id: config.id,
    version: config.version,
    name: config.name,
    description: config.description ?? '',
    model: modelId(config.model),
    system: config.system ?? '',
    tools: (config.tools ?? []).map(toolName),
    skills: (config.skills ?? []).map(skillId),
    response_format: config.response_format ?? '',
    owner_team: String(metadata.owner_team ?? ''),
    repo_mode: metadata.include_all_repository_aliases_by_default
      ? 'all'
      : (metadata.default_repository_aliases?.length ? 'defaults' : 'none'),
    default_aliases: (metadata.default_repository_aliases ?? []).join(', '),
    notify_slack: (metadata.notification_defaults ?? []).some((n) => n.type === 'slack'),
  };
}

function toConfig(form: FormState): AgentConfig {
  const metadata: AgentConfig['metadata'] = {};
  if (form.owner_team.trim()) metadata.owner_team = form.owner_team.trim();
  if (form.repo_mode === 'all') metadata.include_all_repository_aliases_by_default = true;
  if (form.repo_mode === 'defaults') {
    metadata.default_repository_aliases = form.default_aliases.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (form.notify_slack) metadata.notification_defaults = [{ type: 'slack' }];
  return {
    type: 'agent',
    id: form.id.trim(),
    version: form.version,
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    model: form.model,
    system: form.system,
    tools: form.tools,
    skills: form.skills,
    response_format: form.response_format || undefined,
    metadata,
  };
}

export function AgentBuilder() {
  const { id: editId } = useParams<{ id?: string }>();
  const [search] = useSearchParams();
  const cloneFrom = search.get('from');
  const editing = Boolean(editId);
  const { data: catalog } = useCatalog();

  const [form, setForm] = useState<FormState>(BLANK);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<AgentPreview | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  // Prefill from the catalog when editing or cloning.
  useEffect(() => {
    if (!catalog || loaded) return;
    const source = editId ?? cloneFrom;
    if (source) {
      const agent = catalog.agents.find((a) => a.id === source);
      if (agent?.config) {
        const state = fromConfig(agent.config);
        if (editId) {
          state.version = agent.config.version + 1; // authoring convention: bump on change
        } else {
          state.id = '';
          state.name = `${state.name} (copy)`;
          state.version = 1;
        }
        setForm(state);
      }
    }
    setLoaded(true);
  }, [catalog, editId, cloneFrom, loaded]);

  const config = useMemo(() => toConfig(form), [form]);

  // Live preview — the server is the single source of truth for validation
  // and canonical YAML.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      api.post<AgentPreview>('/api/agents/preview', { config })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
  }, [config, loaded]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setPublished(null);
  }

  function toggle(list: 'tools' | 'skills', value: string) {
    setForm((f) => ({
      ...f,
      [list]: f[list].includes(value) ? f[list].filter((v) => v !== value) : [...f[list], value],
    }));
    setPublished(null);
  }

  async function publish() {
    setPublishError(null);
    setPublishing(true);
    try {
      const needsOverwrite = Boolean(preview?.exists);
      if (needsOverwrite && !editing) {
        if (!window.confirm(`agents/${config.id}/agent.yaml already exists (v${preview?.existing_version}). Overwrite it?`)) {
          setPublishing(false);
          return;
        }
      }
      const out = await api.post<PublishResult>('/api/agents/publish', {
        config,
        overwrite: needsOverwrite,
      });
      setPublished(out);
    } catch (e) {
      setPublishError(describeError(e));
    } finally {
      setPublishing(false);
    }
  }

  if (!catalog) return null;
  const problems = preview?.problems ?? [];
  const warnings = preview?.warnings ?? [];

  return (
    <>
      <div className="crumbs"><Link to="/agents">Agents</Link> / {editing ? `Edit ${editId}` : 'New agent'}</div>
      <div className="page-head">
        <div>
          <h1>{editing ? `Edit ${editId}` : 'Create agent'}</h1>
          <div className="sub">
            Everything here becomes one YAML file in the backend repo — no code.
            Publishing writes <span className="mono">agents/&lt;id&gt;/agent.yaml</span>; deploying is a normal PR.
          </div>
        </div>
      </div>

      {published ? (
        <div className="card">
          <h2>Published</h2>
          <div className="alert info" style={{ marginTop: 4 }}>
            Wrote <span className="mono">{published.path}</span>. {published.next_steps}
          </div>
          <pre className="code">{published.yaml}</pre>
          <div className="form-actions">
            <Link className="btn primary" to={`/agents/${config.id}`}>Open agent page</Link>
            <button type="button" className="btn" onClick={() => setPublished(null)}>Keep editing</button>
          </div>
        </div>
      ) : (
        <div className="builder">
          <div>
            <div className="card">
              <h2>Identity</h2>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="b-name">Name</label>
                  <input id="b-name" type="text" value={form.name}
                    onChange={(e) => {
                      set('name', e.target.value);
                      if (!editing && !form.id) {
                        // suggest an id from the name; the id field stays editable
                      }
                    }}
                    onBlur={() => {
                      if (!editing && !form.id && form.name) {
                        set('id', form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60));
                      }
                    }}
                    placeholder="Table QA Sentinel" />
                </div>
                <div className="field">
                  <label htmlFor="b-id">Agent ID</label>
                  <input id="b-id" type="text" className="mono" value={form.id}
                    onChange={(e) => set('id', e.target.value)} disabled={editing}
                    placeholder="table-qa-sentinel" />
                  <div className="help">Lowercase, digits, hyphens. Becomes the directory name — permanent.</div>
                </div>
              </div>
              <div className="field">
                <label htmlFor="b-desc">Description</label>
                <input id="b-desc" type="text" value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="Runs daily quality checks on warehouse tables and files issues on regressions." />
              </div>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="b-model">Model</label>
                  <select id="b-model" value={form.model} onChange={(e) => set('model', e.target.value)}>
                    {MODEL_CHOICES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <div className="help">Executed by the runtime's Gemini CLI provider; the key lives in Vault.</div>
                </div>
                <div className="field">
                  <label htmlFor="b-version">Version</label>
                  <input id="b-version" type="number" min={1} value={form.version}
                    onChange={(e) => set('version', Number(e.target.value))} />
                  <div className="help">Bump when behavior changes; requests pinning an older version are rejected.</div>
                </div>
              </div>
            </div>

            <div className="card">
              <h2>Behavior — system prompt</h2>
              <div className="field">
                <textarea className="mono" rows={9} value={form.system}
                  onChange={(e) => set('system', e.target.value)}
                  placeholder={'You are a BI data-quality agent.\n\nDescribe durable behavior in plain language: what to investigate, how to judge severity, what a good report contains.'} />
                <div className="help">
                  Plain instructions only. The runtime automatically appends guardrails, run context,
                  cloned repositories, and the output schema — don't paste payloads or placeholders.
                </div>
              </div>
            </div>

            <div className="card">
              <h2>Capabilities</h2>
              <div className="form-row">
                <div className="field">
                  <label>Skills — reusable domain judgment</label>
                  {catalog.skills.map((skill) => {
                    const firstLine = skill.body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
                    return (
                      <label key={skill.id} className="check-row">
                        <input type="checkbox" checked={form.skills.includes(skill.id)}
                          onChange={() => toggle('skills', skill.id)} />
                        {skill.id}
                        <span className="desc">— {firstLine.slice(0, 70)}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="field">
                  <label>Tools — sandboxed actions</label>
                  {catalog.tools.map((tool) => (
                    <label key={tool.name} className="check-row">
                      <input type="checkbox" checked={form.tools.includes(tool.name)}
                        onChange={() => toggle('tools', tool.name)} />
                      {tool.name}
                      <span className="desc">— {tool.description.split('\n')[0].slice(0, 60)}</span>
                    </label>
                  ))}
                  <div className="help">New tool <em>types</em> require a backend code change; these are the supported handlers.</div>
                </div>
              </div>
            </div>

            <div className="card">
              <h2>Output & context</h2>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="b-format">Response format — the output contract</label>
                  <select id="b-format" value={form.response_format}
                    onChange={(e) => set('response_format', e.target.value)}>
                    <option value="">(none — not recommended)</option>
                    {catalog.response_formats.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                  </select>
                  <div className="help">The run's result must match this schema; Slack and the run page render from it.</div>
                </div>
                <div className="field">
                  <label htmlFor="b-owner">Owner team</label>
                  <input id="b-owner" type="text" value={form.owner_team}
                    onChange={(e) => set('owner_team', e.target.value)} placeholder="BI Engineering" />
                </div>
              </div>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="b-repos">Repositories cloned into the workspace</label>
                  <select id="b-repos" value={form.repo_mode}
                    onChange={(e) => set('repo_mode', e.target.value as FormState['repo_mode'])}>
                    <option value="none">None unless the request asks</option>
                    <option value="defaults">A default list</option>
                    <option value="all">Every repository in the catalog</option>
                  </select>
                  {form.repo_mode === 'defaults' && (
                    <input type="text" className="mono" style={{ marginTop: 8 }} value={form.default_aliases}
                      onChange={(e) => set('default_aliases', e.target.value)}
                      placeholder="credible-dbt, airflow-utils" />
                  )}
                </div>
                <div className="field">
                  <label>Notifications</label>
                  <label className="check-row">
                    <input type="checkbox" checked={form.notify_slack}
                      onChange={(e) => set('notify_slack', e.target.checked)} />
                    Post results to Slack
                    <span className="desc">— rendered from the response format, even on failures</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div className="builder-side">
            <div className="card">
              <div className="card-head-row">
                <h2>agent.yaml</h2>
                {preview?.exists && !editing && (
                  <span className="badge">exists — v{preview.existing_version}</span>
                )}
              </div>
              <pre className="code yaml-preview">{preview?.yaml ?? '…'}</pre>
            </div>

            <div className="card">
              <h2>Checks</h2>
              {problems.length === 0 && warnings.length === 0 && (
                <div className="small" style={{ color: 'var(--good)' }}>Valid — matches the runtime's authoring rules.</div>
              )}
              {problems.map((p, i) => <div key={`p${i}`} className="problem">{p}</div>)}
              {warnings.map((w, i) => <div key={`w${i}`} className="warning">{w}</div>)}
              {publishError && <div className="alert error" style={{ marginTop: 10 }}>{publishError}</div>}
              <div className="form-actions">
                <button type="button" className="btn primary" onClick={publish}
                  disabled={publishing || problems.length > 0 || !preview}>
                  {publishing ? 'Publishing…' : editing ? 'Publish new version' : 'Publish agent.yaml'}
                </button>
                <Link to={editing ? `/agents/${editId}` : '/agents'} className="btn">Cancel</Link>
              </div>
              <div className="muted small" style={{ marginTop: 6 }}>
                Writes the file into the backend checkout. Review + PR happens there; the console never commits.
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
