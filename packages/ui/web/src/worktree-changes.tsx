// The Changes modal of a task (brief section 7): the task branch against its base commit (`git diff
// <base>...<branch>`) plus the worktree's uncommitted changes, each marked "uncommitted" (M-029), as a file list with
// status letters and +n/-n stats beside the selected file's diff. Ported from gongiskhan/jevellan at 8e2788ec
// (apps/web/src/worktree-changes.tsx), which could show only uncommitted changes; this one reads GET
// /api/tasks/:id/changes (jv task changes T --json).

import { useMemo, useState } from 'react';
import { getChanges, useResource } from './api.js';
import { ChangesDiff, diffSections, type DiffSection } from './changes-diff.js';
import { ErrorLine, Loading, Modal } from './components.js';
import type { ChangedFileView } from './types.js';

const STATUS_NAMES: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };

/** Pairs every listed file with its diff section: committed sections come first, then the worktree's. */
export function pairSections(files: readonly ChangedFileView[], sections: readonly DiffSection[]): Array<DiffSection | undefined> {
  const used = new Set<number>();
  return files.map((file) => {
    const index = sections.findIndex((section, i) => !used.has(i) && (section.path === file.path || section.path === file.oldPath));
    if (index < 0) return undefined;
    used.add(index);
    return sections[index];
  });
}

export function TaskChangesModal({ taskId, title, close }: { taskId: string; title: string; close(): void }) {
  const changes = useResource(`changes:${taskId}`, (signal) => getChanges(taskId, false, signal), { live: false });
  const [selected, setSelected] = useState(0);
  const data = changes.data;
  const sections = useMemo(() => (data?.diff ? diffSections(data.diff) : []), [data]);
  const paired = useMemo(() => (data ? pairSections(data.files, sections) : []), [data, sections]);
  const files = data?.files ?? [];
  const current = files[selected];
  const section = paired[selected];
  const uncommitted = files.filter((file) => file.uncommitted).length;
  return (
    <div className="worktree-changes-dialog">
      <Modal title={title} close={close} wide>
        <div className="worktree-changes-bar">
          <span className="muted small-text" title={data?.worktree ?? undefined}>
            {data
              ? `${data.branch} against ${data.base.slice(0, 12)} · ${files.length} changed file${files.length === 1 ? '' : 's'}${uncommitted ? ` · ${uncommitted} uncommitted` : ''}${data.worktree ? '' : ' · worktree not on disk'}${data.truncated ? ' · truncated' : ''}`
              : ''}
          </span>
          <button type="button" className="secondary small" disabled={changes.loading} onClick={() => changes.reload()}>
            Refresh
          </button>
        </div>
        {changes.loading && !data && <Loading text="Reading the changes..." />}
        <ErrorLine text={changes.error} />
        {data && files.length === 0 && <p className="muted">No changes on the branch and none uncommitted.</p>}
        {data && files.length > 0 && (
          <div className="worktree-changes">
            <ul className="worktree-changes-files" aria-label="Changed files">
              {files.map((file, index) => (
                <li key={`${file.uncommitted ? 'u' : 'c'}:${file.path}`}>
                  <button
                    type="button"
                    className={index === selected ? 'selected' : ''}
                    aria-current={index === selected ? 'true' : undefined}
                    onClick={() => setSelected(index)}
                    title={`${STATUS_NAMES[file.status] ?? file.status} ${file.oldPath ? `${file.oldPath} -> ` : ''}${file.path}${file.uncommitted ? ' (uncommitted)' : ''}`}
                  >
                    <span className={`worktree-status status-${file.status}`}>{file.status}</span>
                    <span className="worktree-file-path">{file.path}</span>
                    {file.uncommitted && <span className="chip uncommitted-chip">uncommitted</span>}
                    <span className="diff-stats">
                      {file.binary ? (
                        <span className="muted">binary</span>
                      ) : (
                        <>
                          <span className="added">+{file.added}</span>
                          <span className="removed">-{file.removed}</span>
                        </>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="worktree-changes-diff">
              {section && current ? (
                <ChangesDiff key={`${selected}`} section={section} label={`${current.path}${current.uncommitted ? ' (uncommitted)' : ''}`} />
              ) : (
                <p className="muted">{current ? 'No text diff for this file (binary, too large, or cut).' : ''}</p>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
