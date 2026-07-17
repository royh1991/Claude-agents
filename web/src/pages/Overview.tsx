import { Link } from 'react-router-dom';
import { useFetch, useCatalog, agentNameIndex } from '../hooks';
import type { OverviewData } from '../types';
import { RunTable } from '../components/RunBits';
import { StatusChip } from '../components/bits';
import { percent } from '../format';

export function Overview() {
  const { data, error } = useFetch<OverviewData>('/api/overview', 10000);
  const { data: catalog } = useCatalog();

  if (error && !data) return <div className="alert error">Couldn't load the overview: {error}</div>;
  if (!data) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <div className="sub" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <StatusChip status={data.run_mode} />
            <span>
              {data.agents_count} agents · {data.triggers_count} triggers ·
              runs execute in Airflow as <span className="mono">ai-agent-runner</span>
            </span>
          </div>
        </div>
        <div className="actions">
          <Link to="/agents/new" className="btn primary">Create agent</Link>
        </div>
      </div>

      {data.backend.using_fixture && (
        <div className="alert info">
          Reading the bundled backend fixture. Point <span className="mono">BACKEND_REPO_ROOT</span> at
          a <span className="mono">credible-bi-airflow-triage</span> checkout to author against the real catalogs.
        </div>
      )}
      {data.runs_error && (
        <div className="alert error">Airflow is unreachable: {data.runs_error}</div>
      )}

      <div className="grid cols-4">
        <div className="tile">
          <div className="label">Active runs</div>
          <div className="value">{data.active_runs}</div>
          <div className="hint">queued or running now</div>
        </div>
        <div className="tile">
          <div className="label">Runs, last 7 days</div>
          <div className="value">{data.runs_7d}</div>
          <div className="hint">scheduled and manual</div>
        </div>
        <div className="tile">
          <div className="label">Green rate</div>
          <div className="value">{percent(data.green_rate_7d)}</div>
          <div className="hint">finished runs, last 7 days</div>
        </div>
        <div className="tile">
          <div className="label">Agents</div>
          <div className="value">{data.agents_count}</div>
          <div className="hint">{data.skills_count} skills · {data.tools_count} tools · {data.response_formats_count} formats</div>
        </div>
      </div>

      <div className="grid cols-sidebar" style={{ marginTop: 16 }}>
        <div className="card table-card">
          <div className="card-head-row" style={{ padding: '10px 12px 0' }}>
            <h2>Recent runs</h2>
            <Link to="/runs" className="small">View all</Link>
          </div>
          <RunTable runs={data.recent_runs} agentNames={agentNameIndex(catalog)} />
        </div>
        <div className="card">
          <h2>Backend</h2>
          <dl className="kv">
            <dt>Package</dt><dd className="mono small">{data.backend.package_dir}</dd>
            <dt>Checkout</dt><dd className="mono small">{data.backend.repo_root}</dd>
            <dt>Run mode</dt><dd><StatusChip status={data.run_mode} /></dd>
          </dl>
          <hr className="rule" />
          <div className="muted small">
            Publishing writes YAML files into this checkout — review and open a
            PR from there. The console never commits, deploys, or touches Vault.
          </div>
        </div>
      </div>
    </>
  );
}
