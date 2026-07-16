import { useNavigate } from 'react-router-dom';
import type { Session } from '../types';
import { StatusChip, EmptyState } from './bits';
import { timeAgo, duration, tokens } from '../format';

export function SessionTable({ sessions, agentIndex, showAgent = true }: {
  sessions: Session[];
  agentIndex: Map<string, { name: string; model: string }>;
  showAgent?: boolean;
}) {
  const navigate = useNavigate();
  if (sessions.length === 0) {
    return (
      <EmptyState glyph="—">
        No sessions here yet. Sessions appear when a schedule fires or you start one from an agent page.
      </EmptyState>
    );
  }
  return (
    <div className="table-scroll">
      <table className="list">
        <thead>
          <tr>
            <th>Session</th>
            <th>Status</th>
            {showAgent && <th>Agent</th>}
            <th>Duration</th>
            <th className="right">Tokens</th>
            <th className="right">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const agent = agentIndex.get(s.agent.id);
            const done = s.status === 'idle' || s.status === 'terminated';
            return (
              <tr key={s.id} className="rowlink" onClick={() => navigate(`/sessions/${s.id}`)}>
                <td className="primary">{s.title ?? 'Untitled session'}</td>
                <td><StatusChip status={s.status} /></td>
                {showAgent && <td className="muted">{agent?.name ?? s.agent.id}</td>}
                <td className="muted">{duration(s.created_at, done ? s.updated_at : null)}</td>
                <td className="right mono muted">
                  {s.usage.input_tokens + s.usage.output_tokens > 0
                    ? tokens(s.usage.input_tokens + s.usage.output_tokens)
                    : '—'}
                </td>
                <td className="right muted" title={s.last_event_at ?? undefined}>
                  {timeAgo(s.last_event_at ?? s.created_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
