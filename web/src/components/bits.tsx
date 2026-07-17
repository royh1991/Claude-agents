import { useState } from 'react';
import type { SubsetSchema } from '../types';

const CHIP_LABELS: Record<string, string> = {
  // run / task states
  queued: 'Queued',
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
  up_for_retry: 'Retrying',
  skipped: 'Skipped',
  pending: 'Pending',
  // runtime result statuses
  invalid_input: 'Invalid input',
  resource_error: 'Resource error',
  provider_error: 'Provider error',
  invalid_output: 'Invalid output',
  runtime_error: 'Runtime error',
  // misc
  mock: 'Mock runs',
  airflow: 'Airflow',
  active: 'Active',
};

const CHIP_CLASS: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  success: 'idle',
  failed: 'terminated',
  up_for_retry: 'paused',
  skipped: 'archived',
  pending: 'queued',
  invalid_input: 'paused',
  invalid_output: 'paused',
  resource_error: 'terminated',
  provider_error: 'terminated',
  runtime_error: 'terminated',
  mock: 'paused',
  airflow: 'idle',
  active: 'active',
};

export function StatusChip({ status }: { status: string | null | undefined }) {
  const key = status ?? 'pending';
  return (
    <span className={`chip ${CHIP_CLASS[key] ?? 'queued'}`}>
      <span className="dot" aria-hidden />
      {CHIP_LABELS[key] ?? key}
    </span>
  );
}

export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="id-chip"
      title="Copy"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(id).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'copied' : id}
    </button>
  );
}

export function EmptyState({ glyph = '·', children }: { glyph?: string; children: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="glyph" aria-hidden>{glyph}</div>
      {children}
    </div>
  );
}

export function ModelBadge({ id }: { id: string }) {
  return <span className="badge model">{id}</span>;
}

/* Minimal markdown for prose fields: paragraphs, pipe tables, bold, inline
   code, links, and bullet lists. Input is escaped before any tags are added. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function Markdown({ text }: { text: string }) {
  const blocks = escapeHtml(text).split(/\n\n+/);
  const html = blocks.map((block) => {
    const lines = block.split('\n');
    if (lines.length >= 2 && lines.every((l) => l.trim().startsWith('|'))) {
      const rows = lines
        .filter((l) => !/^\|[\s:-]+\|?[\s:|-]*$/.test(l.trim()))
        .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
      if (rows.length === 0) return '';
      const [head, ...body] = rows;
      return `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
    }
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (/^#{1,4}\s+/.test(lines[0])) {
      const heading = inline(lines[0].replace(/^#{1,4}\s+/, ''));
      const rest = lines.slice(1).join('\n');
      return `<p class="md-h">${heading}</p>${rest ? `<p>${inline(rest).replace(/\n/g, '<br/>')}</p>` : ''}`;
    }
    return `<p>${inline(block).replace(/\n/g, '<br/>')}</p>`;
  }).join('');
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/* Render a JSON-schema-subset object schema as a readable table. */
export function SchemaTable({ schema }: { schema: SubsetSchema | null }) {
  if (!schema) return <div className="muted small">No schema.</div>;
  if (schema.type !== 'object' || !schema.properties) {
    return <pre className="code">{JSON.stringify(schema, null, 2)}</pre>;
  }
  const required = new Set(schema.required ?? []);
  const describe = (s: SubsetSchema): string => {
    if (s.enum) return s.enum.map(String).join(' | ');
    if (s.type === 'array') return `array of ${s.items?.type ?? 'any'}${s.minItems ? ` (min ${s.minItems})` : ''}`;
    const bounds = [
      s.minLength != null ? `minLength ${s.minLength}` : null,
      s.minimum != null ? `min ${s.minimum}` : null,
      s.maximum != null ? `max ${s.maximum}` : null,
    ].filter(Boolean).join(', ');
    return `${s.type ?? 'any'}${bounds ? ` (${bounds})` : ''}`;
  };
  return (
    <table className="list">
      <thead><tr><th>Field</th><th>Type</th><th>Required</th></tr></thead>
      <tbody>
        {Object.entries(schema.properties).map(([name, sub]) => (
          <tr key={name}>
            <td className="mono small">{name}</td>
            <td className="small">
              {describe(sub)}
              {sub.type === 'array' && sub.items?.type === 'object' && sub.items.properties && (
                <span className="muted"> — {Object.keys(sub.items.properties).join(', ')}</span>
              )}
            </td>
            <td className="muted small">{required.has(name) ? 'yes' : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
