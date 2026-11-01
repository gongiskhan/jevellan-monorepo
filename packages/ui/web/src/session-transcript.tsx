// A session's event stream as a transcript (brief section 7, /s/:id): text as Markdown, thinking folded, each tool
// call collapsed to one slim line that shows the tool and the first line of its input (the result inside), usage and
// rate-limit events as one small line, and the start, message, error, report and end events as muted lines. Ported
// in spirit from gongiskhan/jevellan at 8e2788ec (apps/web/src/session-transcript.tsx), reading jv's event kinds
// (core types.ts EVENT_KINDS) instead of the old engine's turns.

import { Fragment } from 'react';
import { Markdown, Stamp } from './components.js';
import { Icon } from './icons.js';
import { ResponseTime } from './response-time.js';
import type { EventView } from './types.js';

type Payload = Record<string, unknown>;

export type TranscriptItem =
  | { type: 'text'; seq: number; at: string; text: string; last: boolean }
  | { type: 'thinking'; seq: number; at: string; text: string }
  | { type: 'tool'; seq: number; at: string; name: string; input: string; output?: string; ok?: boolean }
  | { type: 'line'; seq: number; at: string; tone: 'muted' | 'error' | 'ok' | 'usage'; text: string };

const record = (value: unknown): Payload => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : {});
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** The first line a reader recognises a tool call by: its command, file, pattern or URL, else the input's first line. */
export function toolHint(input: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = undefined;
  }
  const fields = record(parsed);
  for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) return value.split('\n')[0]!.trim();
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(' ');
  }
  return (input.split('\n').find((line) => line.trim()) ?? '').trim();
}

const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function usageLine(p: Payload): string {
  const parts: string[] = [];
  const input = num(p.inputTokens);
  const output = num(p.outputTokens);
  const cacheRead = num(p.cacheReadTokens);
  if (input !== undefined) parts.push(`${tokens(input)} in`);
  if (output !== undefined) parts.push(`${tokens(output)} out`);
  if (cacheRead) parts.push(`${tokens(cacheRead)} cached`);
  const cost = num(p.costUsd);
  if (cost !== undefined) parts.push(`$${cost.toFixed(2)}`);
  return parts.length ? `usage ${parts.join(', ')}` : 'usage';
}

function rateLine(p: Payload): string {
  const parts: string[] = [];
  const five = num(p.fiveHourPct);
  const week = num(p.weeklyPct);
  if (five !== undefined) parts.push(`five hours ${Math.round(five)}%`);
  if (week !== undefined) parts.push(`week ${Math.round(week)}%`);
  return parts.length ? `rate limit ${parts.join(', ')}` : 'rate limit';
}

/** Events in seq order become transcript items; a tool result joins its call by id. */
export function transcriptItems(events: readonly EventView[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { type: 'tool' }>>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = record(event.payload);
    const base = { seq: event.seq, at: event.at };
    switch (event.kind) {
      case 'text': {
        const text = str(p.text) ?? '';
        if (text.trim()) items.push({ type: 'text', ...base, text, last: false });
        break;
      }
      case 'thinking': {
        const text = str(p.text) ?? '';
        if (text.trim()) items.push({ type: 'thinking', ...base, text });
        break;
      }
      case 'tool-call': {
        const item: Extract<TranscriptItem, { type: 'tool' }> = { type: 'tool', ...base, name: str(p.name) ?? 'tool', input: str(p.input) ?? (p.input !== undefined ? JSON.stringify(p.input) : '') };
        items.push(item);
        const id = str(p.id);
        if (id) tools.set(id, item);
        break;
      }
      case 'tool-result': {
        const id = str(p.id);
        const call = id ? tools.get(id) : undefined;
        const output = str(p.output) ?? (p.output !== undefined ? JSON.stringify(p.output) : '');
        const ok = typeof p.ok === 'boolean' ? p.ok : undefined;
        if (call) {
          call.output = output;
          if (ok !== undefined) call.ok = ok;
        } else items.push({ type: 'tool', ...base, name: str(p.name) ?? 'result', input: '', output, ...(ok !== undefined ? { ok } : {}) });
        break;
      }
      case 'usage':
        items.push({ type: 'line', ...base, tone: 'usage', text: usageLine(p) });
        break;
      case 'rate-limit':
        items.push({ type: 'line', ...base, tone: 'usage', text: rateLine(p) });
        break;
      case 'start': {
        const what = [str(p.runtime), str(p.provider) && `via ${str(p.provider)}`, str(p.effort)].filter(Boolean).join(' ');
        items.push({ type: 'line', ...base, tone: 'muted', text: `${p.resume ? 'resumed' : 'started'}${what ? ` (${what})` : ''}` });
        break;
      }
      case 'message': {
        const from = str(p.from) ?? 'jv';
        items.push({ type: 'line', ...base, tone: 'muted', text: `from ${from}: ${str(p.text) ?? ''}` });
        break;
      }
      case 'error':
        items.push({ type: 'line', ...base, tone: 'error', text: str(p.message) ?? str(p.text) ?? 'error' });
        break;
      case 'report':
        items.push({ type: 'line', ...base, tone: 'ok', text: `report: ${str(p.status) ?? ''}` });
        break;
      case 'end':
        items.push({ type: 'line', ...base, tone: str(p.status) === 'failed' ? 'error' : 'muted', text: `ended ${str(p.status) ?? ''}${str(p.reason) ? `: ${str(p.reason)}` : ''}` });
        break;
      default:
        items.push({ type: 'line', ...base, tone: 'muted', text: event.kind });
    }
  }
  // The last text before each tool call, message or end closes an assistant turn: it carries the response time.
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.type !== 'text') continue;
    const next = items.slice(i + 1).find((other) => other.type !== 'line' || other.tone !== 'usage');
    if (!next || next.type === 'tool' || (next.type === 'line' && next.tone !== 'usage')) item.last = true;
  }
  return items;
}

export function ToolCall({ name, input, output, ok }: { name: string; input: string; output?: string | undefined; ok?: boolean | undefined }) {
  const hint = toolHint(input);
  const state = ok === false ? 'failed' : output === undefined ? 'running' : 'ok';
  return (
    <details className="tool-call">
      <summary>
        <span className="tool-name">{name}</span>
        {hint && <span className="tool-hint" title={hint}>{hint}</span>}
        <span className={`tool-state ${state}`}>{state === 'failed' ? 'failed' : state === 'running' ? 'no result yet' : ''}</span>
      </summary>
      {input && (
        <>
          <div className="tool-label">Input</div>
          <pre><code>{input}</code></pre>
        </>
      )}
      {output !== undefined && (
        <>
          <div className="tool-label">Output</div>
          <pre><code>{output || 'No text output.'}</code></pre>
        </>
      )}
    </details>
  );
}

export function Transcript({ events }: { events: readonly EventView[] }) {
  const items = transcriptItems(events);
  if (!items.length) return <p className="muted">No events yet.</p>;
  return (
    <div className="session-transcript">
      {items.map((item) => (
        <Fragment key={item.seq}>
          {item.type === 'text' && (
            <div className="transcript-text">
              <Markdown>{item.text}</Markdown>
              {item.last && <ResponseTime at={item.at} />}
            </div>
          )}
          {item.type === 'thinking' && (
            <details className="transcript-thinking">
              <summary>Thinking</summary>
              <p>{item.text}</p>
            </details>
          )}
          {item.type === 'tool' && <ToolCall name={item.name} input={item.input} output={item.output} ok={item.ok} />}
          {item.type === 'line' && (
            <p className={`transcript-line tone-${item.tone}`}>
              {item.tone === 'error' && <Icon name="cross" size={13} />}
              <span>{item.text}</span>
              <Stamp at={item.at} className="transcript-time" />
            </p>
          )}
        </Fragment>
      ))}
    </div>
  );
}
