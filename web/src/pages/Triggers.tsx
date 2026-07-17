import { useEffect, useMemo, useState } from 'react';
import { api, describeError } from '../api';
import { useCatalog, useFetch } from '../hooks';
import type { TriggerConfig, PublishResult } from '../types';
import { EmptyState } from '../components/bits';
import { shortDateTime } from '../format';

interface TriggerForm {
  id: string;
  description: string;
  agent_id: string;
  event: TriggerConfig['source']['event'];
  dag_id: string;
  cron: string;
  timezone: string;
  title: string;
  response_format: string;
  aliases: string;
  message: string;
}

const BLANK: TriggerForm = {
  id: '', description: '', agent_id: '', event: 'on_failure', dag_id: '',
  cron: '0 6 * * *', timezone: 'America/New_York',
  title: '', response_format: '', aliases: '', message: '',
};

export function Triggers() {
  const { data: catalog, reload } = useCatalog();
  const [building, setBuilding] = useState(false);
  const [form, setForm] = useState<TriggerForm>(BLANK);
  const [preview, setPreview] = useState<{ yaml: string | null; problems: string[] } | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const cronQuery = form.event === 'schedule'
    ? `/api/cron_preview?expression=${encodeURIComponent(form.cron)}&timezone=${encodeURIComponent(form.timezone)}`
    : null;
  const { data: cronPreview, error: cronError } = useFetch<{ upcoming_runs_at: string[] }>(cronQuery);

  const config = useMemo<TriggerConfig>(() => ({
    type: 'trigger',
    id: form.id.trim(),
    description: form.description.trim() || undefined,
    agent: { id: form.agent_id || (catalog?.agents[0]?.id ?? '') },
    source: form.event === 'schedule'
      ? { event: 'schedule', schedule: { cron: form.cron, timezone: form.timezone } }
      : form.event === 'manual'
        ? { event: 'manual' }
        : { event: form.event, dag_id: form.dag_id.trim() },
    request: {
      title: form.title.trim() || undefined,
      response_format: form.response_format || undefined,
      resources: form.aliases.split(',').map((s) => s.trim()).filter(Boolean)
        .map((alias) => ({ type: 'repository_alias' as const, alias })),
      message: form.message,
    },
  }), [form, catalog]);

  useEffect(() => {
    if (!building) return;
    const t = setTimeout(() => {
      api.post<{ yaml: string | null; problems: string[] }>('/api/triggers/preview', { config })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
  }, [config, building]);

  function set<K extends keyof TriggerForm>(key: K, value: TriggerForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setPublished(null);
  }

  async function publish() {
    setPublishError(null);
    try {
      const out = await api.post<PublishResult>('/api/triggers/publish', { config, overwrite: false });
      setPublished(out);
      setBuilding(false);
      setForm(BLANK);
      reload();
    } catch (e) {
      setPublishError(describeError(e));
    }
  }

  if (!catalog) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Triggers</h1>
          <div className="sub">
            Declarative YAML describing when upstream DAGs (or a schedule) should start an agent
            session. Wiring a trigger into a real DAG is a reviewed backend step — never generated code.
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => setBuilding((v) => !v)}>
            New trigger
          </button>
        </div>
      </div>

      <div className="alert info">
        The trigger YAML shape is versioned (<span className="mono">schema_version: 1</span>) and marked
        as a proposal until it's reconciled with <span className="mono">managed_agent_frontend.md</span> in
        the backend repo.
      </div>

      {published && (
        <div className="alert info">
          Wrote <span className="mono">{published.path}</span>. {published.next_steps}
        </div>
      )}

      {building && (
        <div className="builder" style={{ marginBottom: 16 }}>
          <div className="card">
            <h2>Definition</h2>
            {publishError && <div className="alert error">{publishError}</div>}
            <div className="form-row">
              <div className="field">
                <label htmlFor="t-id">Trigger ID</label>
                <input id="t-id" type="text" className="mono" value={form.id}
                  onChange={(e) => set('id', e.target.value)} placeholder="dbt-core-failure-triage" />
              </div>
              <div className="field">
                <label htmlFor="t-agent">Agent</label>
                <select id="t-agent" value={form.agent_id || catalog.agents[0]?.id}
                  onChange={(e) => set('agent_id', e.target.value)}>
                  {catalog.agents.map((a) => <option key={a.id} value={a.id}>{a.config?.name ?? a.id}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="t-desc">Description</label>
              <input id="t-desc" type="text" value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="Fire triage whenever dbt-core has failed nodes." />
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="t-event">Fires</label>
                <select id="t-event" value={form.event}
                  onChange={(e) => set('event', e.target.value as TriggerForm['event'])}>
                  <option value="on_failure">when an upstream DAG fails</option>
                  <option value="on_success">when an upstream DAG succeeds</option>
                  <option value="schedule">on a schedule</option>
                  <option value="manual">manually only</option>
                </select>
              </div>
              {form.event === 'schedule' ? (
                <div className="field">
                  <label htmlFor="t-cron">Cron · timezone</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input id="t-cron" type="text" className="mono" value={form.cron}
                      onChange={(e) => set('cron', e.target.value)} style={{ flex: 1 }} />
                    <input type="text" value={form.timezone} aria-label="Timezone"
                      onChange={(e) => set('timezone', e.target.value)} style={{ flex: 1 }} />
                  </div>
                  {cronError
                    ? <div className="help" style={{ color: 'var(--bad)' }}>{cronError}</div>
                    : cronPreview && (
                      <div className="help">Next: {cronPreview.upcoming_runs_at.slice(0, 3).map((d) => shortDateTime(d)).join(' · ')}</div>
                    )}
                </div>
              ) : form.event !== 'manual' ? (
                <div className="field">
                  <label htmlFor="t-dag">Upstream DAG id</label>
                  <input id="t-dag" type="text" className="mono" value={form.dag_id}
                    onChange={(e) => set('dag_id', e.target.value)} placeholder="dbt-core" />
                </div>
              ) : <div />}
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="t-format">Response format</label>
                <select id="t-format" value={form.response_format}
                  onChange={(e) => set('response_format', e.target.value)}>
                  <option value="">(agent default)</option>
                  {catalog.response_formats.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="t-repos">Repositories (aliases)</label>
                <input id="t-repos" type="text" className="mono" value={form.aliases}
                  onChange={(e) => set('aliases', e.target.value)} placeholder="credible-dbt" />
              </div>
            </div>
            <div className="field">
              <label htmlFor="t-msg">Message each firing sends</label>
              <textarea id="t-msg" value={form.message} onChange={(e) => set('message', e.target.value)}
                placeholder="Triage the failed {{ dag_id }} build. Failed nodes and run context arrive in metadata." />
            </div>
            <div className="form-actions">
              <button type="button" className="btn primary" onClick={publish}
                disabled={(preview?.problems.length ?? 1) > 0}>
                Publish trigger YAML
              </button>
              <button type="button" className="btn" onClick={() => setBuilding(false)}>Cancel</button>
            </div>
          </div>
          <div className="builder-side">
            <div className="card">
              <h2>agent_triggers/{form.id || '<id>'}.yaml</h2>
              <pre className="code yaml-preview">{preview?.yaml ?? '…'}</pre>
              {(preview?.problems ?? []).map((p, i) => <div key={i} className="problem">{p}</div>)}
            </div>
          </div>
        </div>
      )}

      <div className="card table-card">
        {catalog.triggers.length === 0 ? (
          <EmptyState glyph="↯">
            No trigger YAML in <span className="mono">agent_triggers/</span> yet.
            The dbt-core canaries currently wire their triggers in Python — new
            triggers should be declared here instead.
          </EmptyState>
        ) : (
          <table className="list">
            <thead><tr><th>Trigger</th><th>Agent</th><th>Fires</th><th>Format</th></tr></thead>
            <tbody>
              {catalog.triggers.map((t) => {
                const cfg = t.config as Record<string, any> | null;
                return (
                  <tr key={t.id}>
                    <td>
                      <div className="primary mono small">{t.id}</div>
                      <div className="muted small">{cfg?.description ?? t.parse_error ?? ''}</div>
                    </td>
                    <td className="muted small">{cfg?.agent?.id ?? '—'}</td>
                    <td className="muted small">
                      {cfg?.source?.event === 'schedule'
                        ? `${cfg.source.schedule?.cron} (${cfg.source.schedule?.timezone})`
                        : `${cfg?.source?.event ?? '—'}${cfg?.source?.dag_id ? ` · ${cfg.source.dag_id}` : ''}`}
                    </td>
                    <td className="muted small">{cfg?.request?.response_format ?? 'agent default'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
