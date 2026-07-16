import { useState } from 'react';
import type { SessionStatus } from '../types';

const CHIP_LABELS: Record<string, string> = {
  running: 'Running',
  idle: 'Idle',
  queued: 'Queued',
  terminated: 'Terminated',
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
  online: 'Online',
  offline: 'Offline',
  never_seen: 'No worker yet',
};

export function StatusChip({ status }: { status: SessionStatus | string }) {
  return (
    <span className={`chip ${status}`}>
      <span className="dot" aria-hidden />
      {CHIP_LABELS[status] ?? status}
    </span>
  );
}

export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="id-chip"
      title="Copy ID"
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

export function ModelBadge({ model }: { model: { id: string } }) {
  return <span className="badge model">{model.id}</span>;
}

/* Minimal markdown for agent messages: paragraphs, pipe tables, bold,
   inline code, and links. Input is escaped before any tags are added. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      const [head, ...body] = rows;
      return `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
    }
    return `<p>${inline(block).replace(/\n/g, '<br/>')}</p>`;
  }).join('');
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
