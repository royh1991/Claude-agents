import { useState } from 'react';
import { useFetch, useAgentIndex } from '../hooks';
import type { Session } from '../types';
import { SessionTable } from '../components/SessionTable';

export function Sessions() {
  const [status, setStatus] = useState('');
  const [agentId, setAgentId] = useState('');
  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (agentId) query.set('agent_id', agentId);
  const { data, error } = useFetch<{ data: Session[] }>(`/v1/sessions?${query}`, 10000);
  const agentIndex = useAgentIndex();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Sessions</h1>
          <div className="sub">Every agent run, live or finished — the full event history is kept for each one.</div>
        </div>
      </div>

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="queued">Queued</option>
          <option value="idle">Idle</option>
          <option value="terminated">Terminated</option>
        </select>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Filter by agent">
          <option value="">All agents</option>
          {[...agentIndex.entries()].map(([id, a]) => (
            <option key={id} value={id}>{a.name}</option>
          ))}
        </select>
      </div>

      {error && <div className="alert error">Couldn't load sessions: {error}</div>}
      <div className="card table-card">
        <SessionTable sessions={data?.data ?? []} agentIndex={agentIndex} />
      </div>
    </>
  );
}
