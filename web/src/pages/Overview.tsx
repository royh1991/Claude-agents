import { Link } from 'react-router-dom';
import { useFetch, useAgentIndex } from '../hooks';
import type { Overview as OverviewData } from '../types';
import { ActivityChart } from '../components/ActivityChart';
import { SessionTable } from '../components/SessionTable';
import { percent, timeUntil } from '../format';

export function Overview() {
  const { data, error } = useFetch<OverviewData>('/v1/overview', 15000);
  const agentIndex = useAgentIndex();

  if (error) return <div className="alert error">Couldn't load the overview: {error}</div>;
  if (!data) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <div className="sub">
            {data.agents_count} agents · {data.deployments_active} active schedules · execution in Airflow
          </div>
        </div>
        <div className="actions">
          <Link to="/agents/new" className="btn primary">Create agent</Link>
        </div>
      </div>

      <div className="grid cols-4">
        <div className="tile">
          <div className="label">Active sessions</div>
          <div className="value">{data.active_sessions}</div>
          <div className="hint">running or waiting for a worker</div>
        </div>
        <div className="tile">
          <div className="label">Sessions today</div>
          <div className="value">{data.sessions_today}</div>
          <div className="hint">scheduled and manual</div>
        </div>
        <div className="tile">
          <div className="label">Success rate</div>
          <div className="value">{percent(data.success_rate_7d)}</div>
          <div className="hint">finished sessions, last 7 days</div>
        </div>
        <div className="tile">
          <div className="label">Session hours</div>
          <div className="value">{data.session_hours_7d}</div>
          <div className="hint">last 7 days</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Sessions per day — last 14 days</h2>
        <ActivityChart data={data.sessions_per_day} />
      </div>

      <div className="grid cols-sidebar" style={{ marginTop: 16 }}>
        <div className="card table-card">
          <div className="card-head-row" style={{ padding: '10px 12px 0' }}>
            <h2>Recent sessions</h2>
            <Link to="/sessions" className="small">View all</Link>
          </div>
          <SessionTable sessions={data.recent_sessions} agentIndex={agentIndex} />
        </div>
        <div className="card">
          <h2>Next scheduled runs</h2>
          {data.upcoming_runs.length === 0 && (
            <div className="muted small">No active schedules. <Link to="/deployments/new">Create one</Link>.</div>
          )}
          {data.upcoming_runs.map((run) => (
            <div key={`${run.deployment_id}-${run.at}`}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line-2)' }}>
              <Link to={`/deployments/${run.deployment_id}`}>{run.name}</Link>
              <span className="muted small" title={run.at}>{timeUntil(run.at)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
