import type { SessionEvent } from '../types';
import { clockTime, tokens } from '../format';
import { Markdown } from './bits';

function GlyphIcon({ kind }: { kind: 'user' | 'agent' | 'thinking' | 'tool' | 'mcp' | 'error' }) {
  const paths: Record<string, string> = {
    user: 'M6 3.2a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM2.5 10.5c.6-2 2-3 3.5-3s2.9 1 3.5 3',
    agent: 'M6 1.5v9M1.5 6h9M2.8 2.8l6.4 6.4M9.2 2.8 2.8 9.2',
    thinking: 'M6 2a3.4 3.4 0 0 1 1.8 6.3c-.3.2-.5.5-.5.9v.3H4.7v-.3c0-.4-.2-.7-.5-.9A3.4 3.4 0 0 1 6 2ZM4.8 11h2.4',
    tool: 'M2 3.5 5 6l-3 2.5M6.5 9.5H10',
    mcp: 'M4.2 1.5v3M7.8 1.5v3M3 4.5h6v2a3 3 0 0 1-6 0v-2ZM6 9.5v1',
    error: 'M6 3v3.6M6 8.8h.01M6 1.2 10.8 10H1.2L6 1.2Z',
  };
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[kind]} />
    </svg>
  );
}

function textOf(event: SessionEvent): string {
  return (event.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function pretty(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function previewOf(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const first = obj.command ?? obj.sql ?? obj.title ?? obj.path ?? obj.filter ?? Object.values(obj)[0];
    return typeof first === 'string' ? first : JSON.stringify(first ?? '');
  }
  return String(input);
}

function ToolPair({ use, result }: { use: SessionEvent; result: SessionEvent | null }) {
  const isMcp = use.type === 'agent.mcp_tool_use';
  return (
    <details className="tool-card">
      <summary>
        {isMcp && <span className="server-tag">{use.server}</span>}
        <span className="tool-name">{use.name}</span>
        <span className="preview">{previewOf(use.input)}</span>
        <svg className="chev" width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
          <path d="M3.5 2 7 5 3.5 8" />
        </svg>
      </summary>
      <div className="tool-body">
        <div>
          <div className="io-label">Input</div>
          <pre className="code">{pretty(use.input)}</pre>
        </div>
        <div>
          <div className="io-label">{result ? 'Result' : 'Result pending'}</div>
          {result && <pre className="code">{pretty(result.output)}</pre>}
        </div>
      </div>
    </details>
  );
}

function StatusTick({ event }: { event: SessionEvent }) {
  const kind = event.type.replace('session.status_', '');
  const label =
    kind === 'running' ? `Agent started${event.worker_id ? ` on ${event.worker_id}` : ''}`
    : kind === 'idle' ? `Agent finished — ${event.stop_reason ?? 'end_turn'}`
    : kind === 'terminated' ? `Session terminated${event.stop_reason ? ` — ${event.stop_reason}` : ''}`
    : 'Retrying after a transient error';
  return (
    <div className={`tr-tick ${kind}-tick`}>
      <span className="t-glyph"><span className="d" /></span>
      <span className="label">{label} · {clockTime(event.created_at)}</span>
    </div>
  );
}

export function Trace({ events, running }: { events: SessionEvent[]; running: boolean }) {
  const items: React.ReactNode[] = [];
  const consumed = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (consumed.has(event.id)) continue;
    switch (event.type) {
      case 'user.message':
        items.push(
          <div className="tr-item user" key={event.id}>
            <span className="tr-glyph"><GlyphIcon kind="user" /></span>
            <div className="tr-meta"><span className="who">User</span>{clockTime(event.created_at)}</div>
            <div className="tr-card"><Markdown text={textOf(event)} /></div>
          </div>,
        );
        break;
      case 'agent.message':
        items.push(
          <div className="tr-item" key={event.id}>
            <span className="tr-glyph"><GlyphIcon kind="agent" /></span>
            <div className="tr-meta"><span className="who">Agent</span>{clockTime(event.created_at)}</div>
            <div className="tr-card"><Markdown text={textOf(event)} /></div>
          </div>,
        );
        break;
      case 'agent.thinking':
        items.push(
          <div className="tr-item" key={event.id}>
            <span className="tr-glyph"><GlyphIcon kind="thinking" /></span>
            <div className="tr-thinking">{textOf(event)}</div>
          </div>,
        );
        break;
      case 'agent.tool_use':
      case 'agent.mcp_tool_use': {
        const resultType = event.type === 'agent.tool_use' ? 'agent.tool_result' : 'agent.mcp_tool_result';
        // Pair with the first unclaimed result of the matching type anywhere
        // ahead — batched tool calls emit use,use,result,result and results
        // arrive in call order, so first-in-first-out pairing holds.
        let result: SessionEvent | null = null;
        for (let j = i + 1; j < events.length; j++) {
          if (events[j].type === resultType && !consumed.has(events[j].id)) {
            result = events[j];
            consumed.add(events[j].id);
            break;
          }
        }
        items.push(
          <div className="tr-item" key={event.id}>
            <span className="tr-glyph">
              <GlyphIcon kind={event.type === 'agent.tool_use' ? 'tool' : 'mcp'} />
            </span>
            <ToolPair use={event} result={result} />
          </div>,
        );
        break;
      }
      case 'agent.tool_result':
      case 'agent.mcp_tool_result':
        // Normally consumed by its tool_use; orphaned results render raw.
        items.push(
          <div className="tr-item" key={event.id}>
            <span className="tr-glyph"><GlyphIcon kind="tool" /></span>
            <pre className="code">{pretty(event.output)}</pre>
          </div>,
        );
        break;
      case 'session.status_running':
      case 'session.status_idle':
      case 'session.status_terminated':
      case 'session.status_rescheduled':
        items.push(<StatusTick event={event} key={event.id} />);
        break;
      case 'session.error':
        items.push(
          <div className="tr-item error" key={event.id}>
            <span className="tr-glyph"><GlyphIcon kind="error" /></span>
            <div className="tr-meta"><span className="who">Error</span>{clockTime(event.created_at)}</div>
            <div className="tr-card">
              <div className="etype">{event.error?.type}{event.error?.retry_status ? ` · ${event.error.retry_status}` : ''}</div>
              {event.error?.message}
            </div>
          </div>,
        );
        break;
      case 'user.interrupt':
        items.push(
          <div className="tr-tick terminated-tick" key={event.id}>
            <span className="t-glyph"><span className="d" /></span>
            <span className="label">Interrupt requested · {clockTime(event.created_at)}</span>
          </div>,
        );
        break;
      case 'span.model_request_end':
        items.push(
          <div className="tr-span" key={event.id}>
            {event.model} · {tokens(event.model_usage?.input_tokens ?? 0)} in / {tokens(event.model_usage?.output_tokens ?? 0)} out
          </div>,
        );
        break;
      default:
        break; // span starts and unknown types stay out of the rail
    }
  }

  return (
    <div className="trace">
      {items}
      {running && (
        <div className="live-foot">
          <span className="pulse" aria-hidden />
          Agent is working — events stream in live.
        </div>
      )}
    </div>
  );
}
