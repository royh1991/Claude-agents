import { useState } from 'react';
import { useFetch, useCatalog, agentNameIndex } from '../hooks';
import type { RunSummary } from '../types';
import { RunTable } from '../components/RunBits';
import { StatusChip } from '../components/bits';

export function Runs() {
  const [state, setState] = useState('');
  const [agentId, setAgentId] = useState('');
  const { data, error } = useFetch<{ data: RunSummary[]; mode: string }>('/api/runs?limit=100', 6000);
  const { data: catalog } = useCatalog();

  let runs = data?.data ?? [];
  if (state) runs = runs.filter((r) => r.state === state);
  if (agentId) runs = runs.filter((r) => r.agent_id === agentId);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <div className="sub" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {data && <StatusChip status={data.mode} />}
            <span>Every run is a dag run of <span className="mono">ai-agent-runner</span>; green means the
              structured result passed <span className="mono">evaluate-result</span>.</span>
          </div>
        </div>
      </div>

      <div className="toolbar">
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
          <option value="">All states</option>
          <option value="running">Running</option>
          <option value="queued">Queued</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
        </select>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Filter by agent">
          <option value="">All agents</option>
          {(catalog?.agents ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.config?.name ?? a.id}</option>
          ))}
        </select>
      </div>

      {error && <div className="alert error">Couldn't load runs: {error}</div>}
      <div className="card table-card">
        <RunTable runs={runs} agentNames={agentNameIndex(catalog)} />
      </div>
    </>
  );
}
