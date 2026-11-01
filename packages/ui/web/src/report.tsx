// A step's report as a card (brief section 7, report contract of the skills brief section 5): the summary as
// Markdown; the question and its options as buttons when the status is needs-decision and the task waits on the
// owner, with a free-text answer under them (the options are native buttons whether or not a `ui` array exists);
// testsRun as one line with an SVG tick or cross; changedFiles; screenshots inline from /evidence/ (only images under
// the worktree's .jv-evidence/, as the server checks again, D-064); limitations; ownerCommands each with a copy
// button; and the A2UI surface under "From the step" (a2ui.tsx, loaded on demand).

import { lazy, Suspense, useState } from 'react';
import { answerTask, useAction } from './api.js';
import { CommandLine, ErrorLine, Markdown, Stamp, useApp } from './components.js';
import { Icon } from './icons.js';
import type { ReportView } from './types.js';

// The A2UI renderer (lit, the catalogs, zod 3) is most of the bundle and only reports with a `ui` array need it.
const A2uiBlock = lazy(() => import('./a2ui.js').then((m) => ({ default: m.A2uiBlock })));

const EVIDENCE_DIR = '.jv-evidence';
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;

/** The /evidence/ URL of a screenshot path, or null when it is not an image under the worktree's .jv-evidence/. */
export function evidenceUrl(taskId: string | null, worktree: string | null, path: string): string | null {
  if (!taskId) return null;
  let p = path.replace(/\\/g, '/').trim();
  if (!p || p.includes('\0')) return null;
  if (p.startsWith('/')) {
    if (!worktree) return null;
    const root = `${worktree.replace(/\/+$/, '')}/${EVIDENCE_DIR}/`;
    if (!p.startsWith(root)) return null;
    p = p.slice(root.length);
  } else {
    p = p.replace(/^(\.\/)+/, '');
    if (!p.startsWith(`${EVIDENCE_DIR}/`)) return null;
    p = p.slice(EVIDENCE_DIR.length + 1);
  }
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (!IMAGE.test(p)) return null;
  return `/evidence/${encodeURIComponent(taskId)}/${segments.map(encodeURIComponent).join('/')}`;
}

const STATUS_LABELS: Record<string, string> = { done: 'done', progress: 'progress', blocked: 'blocked', 'needs-decision': 'needs a decision' };

/** The options as buttons and a free-text field under them; each posts jv task answer T "<answer>". */
export function AnswerOptions({ taskId, question, options }: { taskId: string; question?: string | undefined; options: ReadonlyArray<{ label: string; description?: string }> }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string>();
  const action = useAction();
  const { notify } = useApp();
  const answer = (value: string) =>
    void action
      .run(() => answerTask(taskId, value))
      .then((ok) => {
        if (ok) {
          setSent(value);
          setText('');
          notify(`Answered: ${value}`);
        }
      });
  return (
    <div className="answer-card pw-decision">
      {question && <div className="answer-question pw-question"><Markdown>{question}</Markdown></div>}
      {options.length > 0 && (
        <div className="pw-options" role="group" aria-label="Options">
          {options.map((option) => (
            <button key={option.label} type="button" className="secondary pw-option" disabled={action.busy} aria-pressed={sent === option.label} onClick={() => answer(option.label)}>
              <span>{option.label}</span>
              {option.description && <small>{option.description}</small>}
            </button>
          ))}
        </div>
      )}
      <form
        className="pw-answer"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) answer(text.trim());
        }}
      >
        <textarea rows={1} aria-label="Answer in your own words" placeholder="Your own answer" value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit" disabled={action.busy || !text.trim()}>
          Answer
        </button>
      </form>
      {sent && (
        <p className="pw-sent" role="status">
          <Icon name="check" size={14} />
          Sent: {sent}
        </p>
      )}
      <ErrorLine text={action.error} />
    </div>
  );
}

export function TestsLine({ tests }: { tests: NonNullable<ReportView['testsRun']> }) {
  return (
    <div className={`pw-report-tests ${tests.passed ? 'passed' : 'failed'}`}>
      <strong>
        <span className={`test-mark ${tests.passed ? 'pass' : 'fail'}`}>
          <Icon name={tests.passed ? 'check' : 'cross'} size={14} label={tests.passed ? 'Tests passed' : 'Tests failed'} />
        </span>
        {tests.passed ? 'Tests passed' : 'Tests failed'}
      </strong>
      <code>{tests.command}</code>
      {tests.summary && <p>{tests.summary}</p>}
    </div>
  );
}

export function ReportCard({ report, worktree, waitingOnOwner, title }: { report: ReportView; worktree: string | null; waitingOnOwner: boolean; title?: string }) {
  const { readonly } = useApp();
  const decide = report.status === 'needs-decision' && waitingOnOwner && !readonly && report.taskId !== null;
  return (
    <article className={`pw-report pw-report-${report.status}`} aria-label={title ?? 'Report'}>
      <div className="pw-report-head">
        <h3>{title ?? 'Report'}</h3>
        <span className={`chip report-status status-${report.status}`}>{STATUS_LABELS[report.status] ?? report.status}</span>
        <span className="pw-report-note">
          <Stamp at={report.createdAt} />
        </span>
      </div>
      <Markdown>{report.summary}</Markdown>
      {decide ? (
        <AnswerOptions taskId={report.taskId!} question={report.question} options={report.options ?? []} />
      ) : (
        (report.question || (report.options?.length ?? 0) > 0) && (
          <div className="pw-report-question">
            {report.question && <Markdown>{report.question}</Markdown>}
            {report.options && report.options.length > 0 && (
              <ul className="pw-report-options">
                {report.options.map((option) => (
                  <li key={option.label}>
                    {option.label}
                    {option.description && <small>{option.description}</small>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      )}
      {report.testsRun && <TestsLine tests={report.testsRun} />}
      {report.changedFiles.length > 0 && (
        <details className="report-files">
          <summary>
            Changed files <span className="pw-count">{report.changedFiles.length}</span>
          </summary>
          <ul>
            {report.changedFiles.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.screenshots.length > 0 && (
        <div className="report-shots">
          {report.screenshots.map((shot) => {
            const url = shot.url ?? evidenceUrl(report.taskId, worktree, shot.path);
            return (
              <figure key={shot.path} className="report-shot">
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    <img src={url} alt={shot.caption || shot.path} loading="lazy" />
                  </a>
                ) : (
                  <p className="muted small-text">Not served: {shot.path}</p>
                )}
                <figcaption>{shot.caption || shot.path}</figcaption>
              </figure>
            );
          })}
        </div>
      )}
      {report.limitations && (
        <div className="report-limitations">
          <h4>Limitations</h4>
          <p>{report.limitations}</p>
        </div>
      )}
      {report.ownerCommands && report.ownerCommands.length > 0 && (
        <div className="owner-commands">
          <h4>Commands for you</h4>
          {report.ownerCommands.map((command) => (
            <div key={command.command} className="owner-command">
              <CommandLine command={command.command} note={command.cwd ? `in the ${command.cwd}` : undefined} />
              {command.why && <p className="muted small-text">{command.why}</p>}
            </div>
          ))}
        </div>
      )}
      {report.ui && report.ui.length > 0 && (
        <Suspense fallback={<p className="muted small-text">Loading the surface...</p>}>
          <A2uiBlock taskId={report.taskId} reportId={report.id} messages={report.ui} readonly={readonly} />
        </Suspense>
      )}
    </article>
  );
}
