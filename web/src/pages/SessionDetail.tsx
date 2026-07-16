import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, streamSession } from '../api';
import { useFetch, useAgentIndex, useEnvironmentIndex } from '../hooks';
import type { Session, SessionEvent } from '../types';
import { Trace } from '../components/Trace';
import { StatusChip, CopyId } from '../components/bits';
import { shortDateTime, duration, tokens } from '../format';

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: session, reload } = useFetch<Session>(id ? `/v1/sessions/${id}` : null, 8000);
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const agentIndex = useAgentIndex();
  const envIndex = useEnvironmentIndex();

  useEffect(() => {
    if (!id) return;
    let alive = true;
    api.get<{ data: SessionEvent[] }>(`/v1/sessions/${id}/events`)
      .then((r) => { if (alive) setEvents(r.data); })
      .catch(() => { if (alive) setEvents([]); });
    const close = streamSession(id, (event) => {
      if (!alive) return;
      setEvents((prev) => {
        const e = event as SessionEvent;
        if (!prev) return [e];
        if (prev.some((p) => p.id === e.id)) return prev;
        return [...prev, e];
      });
      reload();
    });
    return () => { alive = false; close(); };
  }, [id, reload]);

  if (!session || !events) return null;
  const agent = agentIndex.get(session.agent.id);
  const active = session.status === 'running' || session.status === 'queued';
  const done = session.status === 'idle' || session.status === 'terminated';

  async function send() {
    if (!draft.trim() || !id) return;
    setSending(true);
    setFormError(null);
    try {
      await api.post(`/v1/sessions/${id}/events`, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: draft.trim() }] }],
      });
      setDraft('');
      reload();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function interrupt() {
    if (!id) return;
    setFormError(null);
    try {
      await api.post(`/v1/sessions/${id}/events`, { events: [{ type: 'user.interrupt' }] });
      reload();
    } catch (e) {
      setFormError((e as Error).message);
    }
  }

  return (
    <>
      <div className="crumbs"><Link to="/sessions">Sessions</Link> / <span className="mono">{session.id.slice(0, 17)}…</span></div>
      <div className="page-head">
        <div>
          <h1>{session.title ?? 'Untitled session'}</h1>
          <div className="sub" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
            <StatusChip status={session.status} />
            <span className="muted small">started {shortDateTime(session.created_at)}</span>
          </div>
        </div>
        {active && (
          <div className="actions">
            <button type="button" className="btn danger" onClick={interrupt}
              disabled={session.interrupt_requested}>
              {session.interrupt_requested ? 'Interrupt requested…' : 'Interrupt'}
            </button>
          </div>
        )}
      </div>

      {formError && <div className="alert error">{formError}</div>}

      <div className="grid cols-sidebar">
        <div>
          <div className="card">
            <Trace events={events} running={session.status === 'running'} />
          </div>

          <div className="composer">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={done
                ? 'Send a follow-up — the session re-queues for the next worker poll.'
                : 'Steer the agent with an additional message…'}
              aria-label="Message to the agent"
            />
            <div className="row">
              <span className="muted small">
                {session.status === 'queued' && 'Waiting for an Airflow worker to claim this session.'}
              </span>
              <button type="button" className="btn primary" onClick={send} disabled={sending || !draft.trim()}>
                Send message
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Details</h2>
          <dl className="kv">
            <dt>Agent</dt>
            <dd>
              <Link to={`/agents/${session.agent.id}`}>{agent?.name ?? session.agent.id}</Link>
              <span className="muted"> · v{session.agent.version}</span>
            </dd>
            <dt>Model</dt>
            <dd><span className="badge model">{agent?.model ?? '—'}</span></dd>
            <dt>Environment</dt>
            <dd><Link to={`/environments/${session.environment_id}`}>{envIndex.get(session.environment_id) ?? session.environment_id}</Link></dd>
            <dt>Duration</dt>
            <dd>{duration(session.created_at, done ? session.updated_at : null)}</dd>
            <dt>Tokens</dt>
            <dd>{tokens(session.usage.input_tokens)} in · {tokens(session.usage.output_tokens)} out</dd>
            {session.stop_reason && (<><dt>Stop reason</dt><dd className="mono">{session.stop_reason}</dd></>)}
            {session.deployment_run_id && (
              <><dt>Trigger</dt><dd className="small">scheduled run <span className="mono">{session.deployment_run_id.slice(0, 14)}…</span></dd></>
            )}
            <dt>Session ID</dt>
            <dd><CopyId id={session.id} /></dd>
          </dl>
          {session.last_error && (
            <div className="alert error" style={{ marginTop: 14, marginBottom: 0 }}>
              <strong className="mono">{session.last_error.type}</strong><br />
              {session.last_error.message}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
