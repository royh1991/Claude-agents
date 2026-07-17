import { useEffect, useMemo, useState } from 'react';
import { api, describeError } from '../api';
import { useCatalog, useFetch } from '../hooks';
import type { TriggerConfig, TriggerFireKind, PublishResult } from '../types';
import { EmptyState } from '../components/bits';
import { shortDateTime } from '../format';

type Condition = 'always' | 'failed_nodes' | 'clean_build';

interface TriggerForm {
  id: string;
  description: string;
  agent_id: string;
  when: TriggerFireKind;
  dag_id: string;
  assets: string;
  cron: string;
  timezone: string;
  condition: Condition;
  title: string;
  response_format: string;
  aliases: string;
  message: string;
}

const BLANK: TriggerForm = {
  id: '', description: '', agent_id: '', when: 'dag_complete', dag_id: '',
  assets: '', cron: '0 6 * * *', timezone: 'America/New_York', condition: 'always',
  title: '', response_format: '', aliases: '', message: '',
};

const WIRING: Record<TriggerFireKind, string> = {
  dag_complete: 'Wired by the standard trailing hook in the upstream DAG (all_done): it reads this YAML, evaluates the condition against the run artifacts, and fires ai-agent-runner.',
  asset_updated: 'Wired by the generic asset-router DAG: its schedule is the union of every asset declared across trigger YAMLs (Airflow 3 Assets); triggering_asset_events picks which triggers fire.',
  schedule: 'Wired by the generic scheduler DAG, which reads trigger YAMLs and fires due ones — no per-trigger DAG is generated.',
  manual: 'Never fires on its own — run it from the console or the API.',
};

function describeFire(cfg: Record<string, any> | null): string {
  const fire = cfg?.fire ?? cfg?.source; // schema v1 fallback: source.event
  if (!fire) return '—';
  const when = fire.when ?? fire.event;
  if (when === 'dag_complete' || when === 'on_failure' || when === 'on_success') {
    return `${fire.dag_id ?? '?'} completes (${(fire.states ?? ['success', 'failed']).join(', ')})`;
  }
  if (when === 'asset_updated') return `asset: ${(fire.assets ?? []).join(', ')}`;
  if (when === 'schedule') return `${fire.schedule?.cron} (${fire.schedule?.timezone})`;
  return String(when ?? '—');
}

function describeCondition(cfg: Record<string, any> | null): string {
  const conds = cfg?.only_if ?? [];
  if (!Array.isArray(conds) || conds.length === 0) return 'always';
  return conds.map((c) => c.type === 'dbt_failed_nodes'
    ? (c.present === false ? 'build is clean' : 'build has failed nodes')
    : c.type).join(' and ');
}

export function Triggers() {
  const { data: catalog, reload } = useCatalog();
  const [building, setBuilding] = useState(false);
  const [form, setForm] = useState<TriggerForm>(BLANK);
  const [preview, setPreview] = useState<{ yaml: string | null; problems: string[] } | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const cronQuery = form.when === 'schedule'
    ? `/api/cron_preview?expression=${encodeURIComponent(form.cron)}&timezone=${encodeURIComponent(form.timezone)}`
    : null;
  const { data: cronPreview, error: cronError } = useFetch<{ upcoming_runs_at: string[] }>(cronQuery);

  const config = useMemo<TriggerConfig>(() => {
    const fire: TriggerConfig['fire'] = { when: form.when };
    if (form.when === 'dag_complete') {
      fire.dag_id = form.dag_id.trim();
      fire.states = ['success', 'failed'];
    }
    if (form.when === 'asset_updated') {
      fire.assets = form.assets.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (form.when === 'schedule') {
      fire.schedule = { cron: form.cron, timezone: form.timezone };
    }
    const only_if: TriggerConfig['only_if'] =
      form.condition === 'failed_nodes' ? [{ type: 'dbt_failed_nodes', present: true }]
        : form.condition === 'clean_build' ? [{ type: 'dbt_failed_nodes', present: false }]
          : undefined;
    return {
      type: 'trigger',
      id: form.id.trim(),
      description: form.description.trim() || undefined,
      agent: { id: form.agent_id || (catalog?.agents[0]?.id ?? '') },
      fire,
      ...(only_if ? { only_if } : {}),
      request: {
        title: form.title.trim() || undefined,
        response_format: form.response_format || undefined,
        resources: form.aliases.split(',').map((s) => s.trim()).filter(Boolean)
          .map((alias) => ({ type: 'repository_alias' as const, alias })),
        metadata: {},
        message: form.message,
      },
    };
  }, [form, catalog]);

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
            Declarative YAML describing when Airflow should start an agent session — on an upstream
            DAG's completion, an asset update, or a schedule. Generic backend DAGs read these files;
            no per-trigger Python is ever generated.
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => setBuilding((v) => !v)}>
            New trigger
          </button>
        </div>
      </div>

      <div className="alert info">
        Trigger YAML is <span className="mono">schema_version: 2</span> — a proposal until it's
        reconciled with <span className="mono">managed_agent_frontend.md</span>. Conditions matter: a
        dbt task can go green while <span className="mono">run_results.json</span> contains failures,
        so "DAG completed" and "build was clean" are separate facts. <strong>Not yet executable:</strong>{' '}
        no backend consumer reads <span className="mono">agent_triggers/</span> yet — the router and
        scheduler DAGs, plus dbt asset outlets for asset triggers, are pending backend work.
        Publishing declares intent for that work to consume.
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
                placeholder="Fire triage whenever dbt-core ships failed nodes." />
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="t-when">Fires</label>
                <select id="t-when" value={form.when}
                  onChange={(e) => set('when', e.target.value as TriggerFireKind)}>
                  <option value="dag_complete">when an upstream DAG completes</option>
                  <option value="asset_updated">when an Airflow asset updates (3.0+)</option>
                  <option value="schedule">on a cron schedule</option>
                  <option value="manual">manually only</option>
                </select>
                <div className="help">{WIRING[form.when]}</div>
              </div>
              {form.when === 'dag_complete' && (
                <div className="field">
                  <label htmlFor="t-dag">Upstream DAG id</label>
                  <input id="t-dag" type="text" className="mono" value={form.dag_id}
                    onChange={(e) => set('dag_id', e.target.value)} placeholder="dbt-core" />
                  <div className="help">Watches every terminal state (all_done) — the condition below decides.</div>
                </div>
              )}
              {form.when === 'asset_updated' && (
                <div className="field">
                  <label htmlFor="t-assets">Asset URIs (comma-separated)</label>
                  <input id="t-assets" type="text" className="mono" value={form.assets}
                    onChange={(e) => set('assets', e.target.value)}
                    placeholder="snowflake://analytics/submissions_output" />
                </div>
              )}
              {form.when === 'schedule' && (
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
              )}
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="t-cond">Condition</label>
                <select id="t-cond" value={form.condition}
                  onChange={(e) => set('condition', e.target.value as Condition)}>
                  <option value="always">Always fire</option>
                  <option value="failed_nodes">Only when the dbt build has failed nodes</option>
                  <option value="clean_build">Only when the dbt build is clean</option>
                </select>
                <div className="help">
                  Evaluated from the run artifacts in S3, not from task state — triage wants
                  "failed nodes present", anomaly scans want "clean build".
                </div>
              </div>
              <div className="field">
                <label htmlFor="t-format">Response format</label>
                <select id="t-format" value={form.response_format}
                  onChange={(e) => set('response_format', e.target.value)}>
                  <option value="">(agent default)</option>
                  {catalog.response_formats.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="t-repos">Repositories (aliases, optional)</label>
                <input id="t-repos" type="text" className="mono" value={form.aliases}
                  onChange={(e) => set('aliases', e.target.value)} placeholder="credible-dbt" />
              </div>
              <div />
            </div>
            <div className="field">
              <label htmlFor="t-msg">Message each firing sends</label>
              <textarea id="t-msg" value={form.message} onChange={(e) => set('message', e.target.value)}
                placeholder="Triage the failed build. Failed nodes and run context arrive in metadata." />
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
          </EmptyState>
        ) : (
          <table className="list">
            <thead><tr><th>Trigger</th><th>Agent</th><th>Fires</th><th>Condition</th><th>Format</th></tr></thead>
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
                    <td className="muted small">{describeFire(cfg)}</td>
                    <td className="muted small">{describeCondition(cfg)}</td>
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
