import { Link, useParams } from 'react-router-dom';
import { useFetch } from '../hooks';
import type { Environment } from '../types';
import { StatusChip, CopyId } from '../components/bits';
import { timeAgo, shortDateTime } from '../format';

export function Environments() {
  const { data, error } = useFetch<{ data: Environment[] }>('/v1/environments', 15000);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Environments</h1>
          <div className="sub">
            Where sessions execute. Each environment is an Airflow deployment inside the VPC;
            its workers poll for queued sessions and hold the credentials.
          </div>
        </div>
      </div>
      {error && <div className="alert error">Couldn't load environments: {error}</div>}
      <div className="grid cols-2">
        {(data?.data ?? []).map((env) => (
          <Link key={env.id} to={`/environments/${env.id}`} className="card" style={{ display: 'block', color: 'inherit' }}>
            <div className="card-head-row">
              <h2 style={{ textTransform: 'none', fontSize: 15, letterSpacing: 0, color: 'var(--ink)' }}>{env.name}</h2>
              <StatusChip status={env.worker.status} />
            </div>
            <dl className="kv">
              <dt>Cluster</dt><dd className="mono">{env.config.cluster}</dd>
              <dt>Namespace</dt><dd className="mono">{env.config.namespace}</dd>
              <dt>Network</dt><dd>{env.config.network_policy === 'vpc_only' ? 'VPC only — no public egress' : env.config.network_policy}</dd>
              <dt>Credentials</dt><dd>{env.config.credentials.map((c) => c.type).join(', ') || 'none'}</dd>
              <dt>Worker seen</dt><dd>{timeAgo(env.worker.last_seen_at)}</dd>
            </dl>
          </Link>
        ))}
      </div>
    </>
  );
}

export function EnvironmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: env } = useFetch<Environment>(id ? `/v1/environments/${id}` : null, 15000);
  if (!env) return null;

  return (
    <>
      <div className="crumbs"><Link to="/environments">Environments</Link> / {env.name}</div>
      <div className="page-head">
        <div>
          <h1>{env.name}</h1>
          <div className="sub" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
            <StatusChip status={env.worker.status} />
            <span className="muted small">worker last seen {timeAgo(env.worker.last_seen_at)}</span>
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Runtime</h2>
          <dl className="kv">
            <dt>Type</dt><dd>Self-hosted (Airflow on Kubernetes)</dd>
            <dt>Cluster</dt><dd className="mono">{env.config.cluster}</dd>
            <dt>Namespace</dt><dd className="mono">{env.config.namespace}</dd>
            <dt>Network</dt><dd>{env.config.network_policy === 'vpc_only' ? 'VPC only — no public egress' : env.config.network_policy}</dd>
            <dt>Worker ID</dt><dd className="mono">{env.worker.worker_id ?? '—'}</dd>
            <dt>Created</dt><dd>{shortDateTime(env.created_at)}</dd>
            <dt>Environment ID</dt><dd><CopyId id={env.id} /></dd>
          </dl>
        </div>
        <div className="card">
          <h2>Mounted credentials</h2>
          <div className="muted small" style={{ marginBottom: 10 }}>
            Held by the Airflow deployment, never by this console. Agents reach them only through the worker.
          </div>
          <table className="list">
            <thead><tr><th>Secret</th><th>Type</th><th>Scope</th></tr></thead>
            <tbody>
              {env.config.credentials.map((cred) => (
                <tr key={cred.name}>
                  <td className="mono small">{cred.name}</td>
                  <td>{cred.type}</td>
                  <td className="muted small">{cred.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
