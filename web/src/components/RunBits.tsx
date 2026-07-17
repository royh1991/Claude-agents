import { useNavigate } from 'react-router-dom';
import type { RunSummary, TaskInstance, ResultEnvelope, SubsetSchema } from '../types';
import { StatusChip, EmptyState, Markdown } from './bits';
import { timeAgo, duration } from '../format';

export function RunTable({ runs, agentNames }: {
  runs: RunSummary[];
  agentNames: Map<string, string>;
}) {
  const navigate = useNavigate();
  if (runs.length === 0) {
    return (
      <EmptyState glyph="—">
        No runs yet. Trigger one from an agent page, or wait for an upstream DAG to fire a trigger.
      </EmptyState>
    );
  }
  return (
    <div className="table-scroll">
      <table className="list">
        <thead>
          <tr>
            <th>Run</th>
            <th>State</th>
            <th>Agent</th>
            <th>Duration</th>
            <th className="right">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.dag_run_id} className="rowlink"
              onClick={() => navigate(`/runs/${encodeURIComponent(run.dag_run_id)}`)}>
              <td className="primary">{run.title ?? run.dag_run_id}</td>
              <td><StatusChip status={run.state} /></td>
              <td className="muted">{run.agent_id ? (agentNames.get(run.agent_id) ?? run.agent_id) : '—'}</td>
              <td className="muted">
                {run.start_date ? duration(run.start_date, run.end_date) : '—'}
              </td>
              <td className="right muted" title={run.logical_date ?? undefined}>
                {timeAgo(run.start_date ?? run.logical_date)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TASK_LABELS: Record<string, string> = {
  'build-request': 'Build request',
  'run-agent': 'Run agent',
  'evaluate-result': 'Evaluate result',
  'post-notifications': 'Notify',
};

export function Pipeline({ tasks }: { tasks: TaskInstance[] }) {
  return (
    <div className="pipeline">
      {tasks.map((task, i) => (
        <div key={task.task_id} className="pipe-node-wrap">
          {i > 0 && <span className="pipe-link" aria-hidden />}
          <div className={`pipe-node state-${task.state ?? 'pending'}`}>
            <div className="pipe-name">{TASK_LABELS[task.task_id] ?? task.task_id}</div>
            <StatusChip status={task.state ?? 'pending'} />
            <div className="pipe-time muted">
              {task.start_date ? duration(task.start_date, task.end_date) : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* Schema-driven renderer for result envelopes: walks the response format's
   schema so any format — including ones authored in the builder — renders
   sensibly without bespoke UI. */
function FieldValue({ value, schema }: { value: unknown; schema: SubsetSchema | undefined }) {
  if (value == null) return <span className="muted">—</span>;
  if (typeof value === 'boolean') {
    return (
      <span className={`chip ${value ? 'paused' : 'idle'}`}>
        <span className="dot" aria-hidden />{value ? 'Yes' : 'No'}
      </span>
    );
  }
  if (typeof value === 'string') {
    if (schema?.enum) return <span className={`badge enum-${value}`}>{value}</span>;
    return <Markdown text={value} />;
  }
  if (typeof value === 'number') return <span className="mono">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">none</span>;
    const itemSchema = schema?.items;
    if (itemSchema?.type === 'object' && itemSchema.properties) {
      const cols = Object.keys(itemSchema.properties);
      return (
        <div className="table-scroll">
          <table className="list">
            <thead><tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
            <tbody>
              {value.map((row, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c} className="small">{String((row as Record<string, unknown>)[c] ?? '—')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    if (value.every((v) => typeof v === 'string' && /select|from|where/i.test(v))) {
      return <>{value.map((sql, i) => <pre key={i} className="code">{String(sql)}</pre>)}</>;
    }
    return (
      <ul className="result-list">
        {value.map((item, i) => <li key={i}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>)}
      </ul>
    );
  }
  return <pre className="code">{JSON.stringify(value, null, 2)}</pre>;
}

export function ResultView({ result, schema }: { result: ResultEnvelope; schema: SubsetSchema | null }) {
  const body = result.result;
  if (!body) return null;
  const order = schema?.properties ? Object.keys(schema.properties) : Object.keys(body);
  const extras = Object.keys(body).filter((k) => !order.includes(k));
  return (
    <div className="result-view">
      {[...order, ...extras].filter((k) => k in body).map((key) => (
        <div className="result-field" key={key}>
          <div className="result-label">{key.replace(/_/g, ' ')}</div>
          <FieldValue value={body[key]} schema={schema?.properties?.[key]} />
        </div>
      ))}
    </div>
  );
}
