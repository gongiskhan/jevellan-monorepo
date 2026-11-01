// A unified diff as file sections with numbered, coloured lines, ported from gongiskhan/jevellan at 8e2788ec
// (apps/web/src/changes-diff.tsx and core's changesDiffView, which the web app now holds itself since it imports no
// engine code). Long lines scroll sideways inside the diff (never the page) unless Wrap lines is on.

import { useState } from 'react';

export interface DiffRow {
  line: string;
  kind: 'hunk' | 'addition' | 'removal' | 'context' | 'meta';
  before?: number;
  after?: number;
}

export interface DiffSection {
  path: string;
  added: number;
  removed: number;
  rows: DiffRow[];
}

function diffRows(text: string): DiffRow[] {
  let before: number | undefined;
  let after: number | undefined;
  return text.split('\n').map((line): DiffRow => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      return { line, kind: 'hunk' };
    }
    if (before === undefined || after === undefined || line.startsWith('\\') || !/^[ +-]/.test(line)) return { line, kind: 'meta' };
    if (line.startsWith('+')) return { line, kind: 'addition', after: after++ };
    if (line.startsWith('-')) return { line, kind: 'removal', before: before++ };
    return { line, kind: 'context', before: before++, after: after++ };
  });
}

/** The sections of a unified diff, one per `diff --git` header, in order. */
export function diffSections(text: string): DiffSection[] {
  return text
    .trimEnd()
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((part) => {
      const rows = diffRows(part.trimEnd());
      const paths = part
        .split('\n')
        .filter((line) => /^(\+\+\+|---) /.test(line))
        .map((line) => line.slice(4).replace(/\t.*$/, ''))
        .filter((path) => path !== '/dev/null');
      const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
      const path = (paths.at(-1) ?? header?.[2] ?? part.split('\n')[0] ?? 'Changes').replace(/^[ab]\//, '');
      return { rows, path, added: rows.filter((row) => row.kind === 'addition').length, removed: rows.filter((row) => row.kind === 'removal').length };
    });
}

export function ChangesDiff({ section, label }: { section: DiffSection; label?: string }) {
  const [wrap, setWrap] = useState(false);
  return (
    <div className="changes-diff">
      <div className="diff-toolbar">
        <span className="muted small-text diff-label" title={section.path}>{label ?? section.path}</span>
        <label>
          <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} /> Wrap lines
        </label>
      </div>
      <div className="diff-file">
        <div className={`diff-scroll${wrap ? ' wrap' : ''}`} tabIndex={0} aria-label={`Diff for ${section.path}`}>
          <div className="diff-lines">
            {section.rows.map((row, index) => (
              <div className={`diff-line ${row.kind}`} key={index}>
                <span className="diff-line-number" aria-hidden="true">{row.before}</span>
                <span className="diff-line-number" aria-hidden="true">{row.after}</span>
                <code>{row.line || ' '}</code>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
