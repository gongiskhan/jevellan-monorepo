// /t/:id, a task (brief section 7): the header (title, id, kind, state with reason, origin, branch, base and landed
// commits), the task text folded after 12 lines, the steps as a timeline with their placement (model label, effort,
// provider, Jev's probability for the chosen model, the override) and under each step its sessions with their
// reports, the landing block (Land now and Leave it when Jev routed it to the owner), child tasks, and the action
// bar: Message, Answer, Stop (only with a live session; discard as a checkbox), Resume, Override (model, effort and
// provider from what the task's placements name; mode undo or keep), Changes (the modal of worktree-changes.tsx) and
// Attach (shows `jv attach R` with a copy button; the UI never attaches itself). Land now and Leave it answer the
// landing ask (core answerTask takes exactly those two labels).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { answerTask, getProviders, getTask, messageTask, overrideTask, resumeTask, stopTask, useAction, useResource } from '../api.js';
import { CommandLine, Confirm, ErrorLine, Loading, Modal, OriginChip, RouteLink, Stamp, StateChip, StateDot, useApp, useNow } from '../components.js';
import { Icon } from '../icons.js';
import { AnswerOptions, ReportCard } from '../report.js';
import { relativeDuration } from '../time.js';
import { TaskChangesModal } from '../worktree-changes.js';
import type { Placement, ProvidersMenu, RunView, StepView, TaskView } from '../types.js';

const LIVE = ['queued', 'starting', 'running'];
const short = (sha: string | null) => (sha ? sha.slice(0, 10) : null);

function liveRun(task: TaskView): RunView | undefined {
  return task.steps.flatMap((s) => s.runs).filter((r) => LIVE.includes(r.state)).at(-1);
}
function latestRun(task: TaskView): RunView | undefined {
  return task.steps
    .flatMap((s) => s.runs)
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
    .at(-1);
}

function tokensText(run: RunView): string {
  const t = run.tokens;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  return `${k(t.input)} in · ${k(t.output)} out${t.cacheRead ? ` · ${k(t.cacheRead)} cached` : ''}`;
}

/** The chosen model's probability in Jev's answer, when Jev chose (D-030). */
function jevProbability(chosen: Placement['chosen']): number | undefined {
  const model = chosen?.choices?.model;
  if (!model || model.source !== 'jev' || !model.option || !model.probabilities) return undefined;
  return model.probabilities[model.option];
}

function placementText(p: Placement): string {
  const c = p.chosen;
  if (!c) return 'no placement recorded';
  const name = c.label ?? c.model ?? '';
  const parts = [`${name}${c.effort ? ` ${c.effort}` : ''}${c.provider ? ` via ${c.provider}` : ''}`];
  if (c.runtime) parts.push(c.runtime);
  const probability = jevProbability(c);
  if (probability !== undefined) parts.push(`Jev ${Math.round(probability * 100)}%`);
  else if (c.source) parts.push(`chosen by ${c.source}`);
  return parts.join(' · ');
}

function TaskText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) setLong(element.scrollHeight > element.clientHeight + 2 || text.split('\n').length > 12);
  }, [text]);
  return (
    <section className="task-text card" aria-label="Task text">
      <div ref={ref} className={`task-text-body ${open ? 'open' : 'clamped'}`}>
        {text}
      </div>
      {(long || open) && (
        <button type="button" className="text-button small-text" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </section>
  );
}

function RunRow({ run, task }: { run: RunView; task: TaskView }) {
  const now = useNow(5000);
  const end = run.endedAt ?? (LIVE.includes(run.state) ? now : run.lastEventAt ?? now);
  return (
    <div className={`run-block state-${run.state}`}>
      <div className="run-row">
        <StateDot state={run.state} lost={run.state === 'lost'} />
        <RouteLink href={`/s/${encodeURIComponent(run.id)}`} className="run-id">
          {run.id}
        </RouteLink>
        <span className="run-what">
          {run.model} {run.effort} via {run.provider} · {run.runtime}
        </span>
        <StateChip state={run.state} />
        <span className="run-facts">
          {run.startedAt && <span>{relativeDuration(run.startedAt, end)}</span>}
          <span>{tokensText(run)}</span>
          {run.costUsd !== null && <span>${run.costUsd.toFixed(2)}</span>}
        </span>
      </div>
      <p className="run-detail">
        {run.stateReason}
        {run.nativeSessionId && <span className="mono"> · native {run.nativeSessionId}</span>}
        {run.tmuxTarget && <span className="mono"> · tmux {run.tmuxTarget}</span>}
        {run.startedAt && (
          <span>
            {' '}
            · <Stamp at={run.startedAt} />
            {run.endedAt && (
              <>
                {' '}
                to <Stamp at={run.endedAt} />
              </>
            )}
          </span>
        )}
      </p>
      {run.report && <ReportCard report={run.report} worktree={task.worktree} waitingOnOwner={task.state === 'waiting-owner' && run === latestRun(task)} title={`Report of ${run.id}`} task={task} />}
    </div>
  );
}

function StepItem({ step, task }: { step: StepView; task: TaskView }) {
  const started = step.runs.map((r) => r.startedAt).filter(Boolean).sort()[0];
  const ended = step.runs.map((r) => r.endedAt).filter(Boolean).sort().at(-1);
  const current = task.currentStep === step.ordinal;
  return (
    <li className={`step-item state-${step.state}${current ? ' current' : ''}`}>
      <div className="step-marker" aria-hidden="true">
        {step.ordinal}
      </div>
      <div className="step-body">
        <div className="step-head">
          <h3 className="step-title">
            Step {step.ordinal} <span>{step.duty}</span>
          </h3>
          <StateChip state={step.state} />
          {step.attempts > 1 && <span className="chip dim">{step.attempts} attempts</span>}
          {step.when !== 'always' && <span className="chip dim">when {step.when}</span>}
          <span className="step-times muted small-text">
            {started && <Stamp at={started} />}
            {started && ended && ' to '}
            {ended && <Stamp at={ended} />}
          </span>
        </div>
        {step.stateReason && <p className="step-reason">{step.stateReason}</p>}
        {step.instructions && <p className="step-instructions muted">{step.instructions}</p>}
        {step.placements.map((p) => (
          <p key={p.id} className="placement-line">
            <Icon name="decisions" size={13} />
            <span>{placementText(p)}</span>
            {p.override && (
              <span className="override-note">
                override {p.override.label ?? p.override.model} {p.override.effort ?? ''}
                {p.override.provider ? ` via ${p.override.provider}` : ''}
                {p.overrideMode ? ` (${p.overrideMode})` : ''}
              </span>
            )}
          </p>
        ))}
        {step.runs.map((run) => (
          <RunRow key={run.id} run={run} task={task} />
        ))}
      </div>
    </li>
  );
}

function LandingBlock({ task }: { task: TaskView }) {
  const { readonly, notify } = useApp();
  const action = useAction();
  if (!task.landings.length) return null;
  const latest = task.landings.at(-1)!;
  const asking = !readonly && latest.route === 'ask-owner' && task.state === 'waiting-owner' && latest.state === 'asked';
  const answer = (label: 'Land now' | 'Leave it') =>
    void action.run(() => answerTask(task.id, label)).then((ok) => ok && notify(label === 'Land now' ? 'Landing.' : 'Left unlanded; the worktree is kept.'));
  return (
    <section className="card landing-card" aria-labelledby="landing-heading">
      <h2 id="landing-heading">Landing</h2>
      {task.landings.map((landing) => (
        <div key={landing.id} className="landing-row">
          <div className="landing-head">
            <span className="chip">{landing.route}</span>
            <StateChip state={landing.state} />
            <Stamp at={landing.createdAt} className="muted small-text" />
            {landing.commit && <code className="landing-commit">{short(landing.commit)}</code>}
          </div>
          {landing.reason && <p className="landing-reason">{landing.reason}</p>}
          {landing.checks.length > 0 && (
            <ul className="landing-checks">
              {landing.checks.map((check, index) => (
                <li key={index} className={check.passed ? 'check-ok' : 'check-failed'}>
                  <Icon name={check.passed ? 'check' : 'cross'} size={13} />
                  <span>{check.name}</span>
                  {check.command && check.command !== check.name && <code className="small-text">{check.command}</code>}
                  <span className="muted"> {check.outcome}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {asking && (
        <div className="actions landing-actions">
          <button type="button" disabled={action.busy} onClick={() => answer('Land now')}>
            Land now
          </button>
          <button type="button" className="secondary" disabled={action.busy} onClick={() => answer('Leave it')}>
            Leave it
          </button>
        </div>
      )}
      <ErrorLine text={action.error} />
    </section>
  );
}

function MessageDialog({ task, close }: { task: TaskView; close(): void }) {
  const [text, setText] = useState('');
  const action = useAction();
  const { notify } = useApp();
  return (
    <Modal title={`Message ${task.id}`} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => messageTask(task.id, text.trim())).then((ok) => {
            if (ok) {
              notify('Message stored for the step.');
              close();
            }
          });
        }}
      >
        <label>
          Message to the step
          <textarea autoFocus rows={5} required value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <p className="muted small-text">A running step gets it on its next turn as "From the owner:".</p>
        <ErrorLine text={action.error} />
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button disabled={action.busy || !text.trim()}>Send</button>
        </div>
      </form>
    </Modal>
  );
}

function AnswerDialog({ task, close }: { task: TaskView; close(): void }) {
  const run = latestRun(task);
  const landing = task.landings.at(-1);
  const landingAsk = landing?.route === 'ask-owner' && landing.state === 'asked';
  const options = landingAsk ? [{ label: 'Land now', description: 'jv land --force' }, { label: 'Leave it', description: 'jv task stop --discard' }] : (run?.report?.options ?? []);
  const question = landingAsk ? 'Land this task?' : run?.report?.question;
  return (
    <Modal title={`Answer ${task.id}`} close={close}>
      <AnswerOptions taskId={task.id} question={question} options={options} />
    </Modal>
  );
}

function StopDialog({ task, close }: { task: TaskView; close(): void }) {
  const [discard, setDiscard] = useState(false);
  const action = useAction();
  const { notify } = useApp();
  return (
    <Confirm
      title={`Stop ${task.id}`}
      action={discard ? 'Stop and discard' : 'Stop'}
      danger
      busy={action.busy}
      error={action.error}
      close={close}
      confirm={() =>
        void action.run(() => stopTask(task.id, discard)).then((ok) => {
          if (ok) {
            notify(discard ? 'Stopped; the task is discarded and its worktree kept.' : 'Stopped.');
            close();
          }
        })
      }
    >
      <p>The running session ends now. Resume continues it later on the same native session.</p>
      <label className="toggle">
        <input type="checkbox" checked={discard} onChange={(event) => setDiscard(event.target.checked)} />
        Discard the task (the worktree is kept)
      </label>
    </Confirm>
  );
}

/**
 * What the Override dialog offers: the providers.json menu (M-068) with the task's own placements first (its runs, Jev's
 * chosen model, effort options and eligible candidates), so the likely choices lead. Efforts and providers follow the
 * model typed when the menu knows it. Without the menu (an error) the task's data alone is offered.
 */
function overrideChoices(task: TaskView, menu: ProvidersMenu | undefined, model: string) {
  const models = new Map<string, string>();
  const taskEfforts = new Set<string>();
  const taskProviders = new Set<string>();
  for (const step of task.steps) {
    for (const run of step.runs) {
      if (run.model) models.set(run.model, models.get(run.model) ?? run.model);
      if (run.effort) taskEfforts.add(run.effort);
      if (run.provider) taskProviders.add(run.provider);
    }
    for (const p of step.placements) {
      const c = p.chosen;
      if (c?.model) models.set(c.model, c.label ? `${c.label} (${c.model})` : c.model);
      if (c?.effort) taskEfforts.add(c.effort);
      for (const option of Object.keys(c?.choices?.effort?.probabilities ?? {})) taskEfforts.add(option);
      if (c?.provider) taskProviders.add(c.provider);
      for (const candidate of c?.candidates ?? []) if (candidate.eligible !== false) taskProviders.add(candidate.name);
    }
  }
  const efforts = new Set<string>();
  const providers = new Set<string>();
  for (const p of menu?.providers ?? []) {
    for (const m of p.models) {
      models.set(m.id, `${m.label} (${m.id})`);
      if (m.id === model.trim()) {
        for (const e of m.efforts) efforts.add(e);
        providers.add(p.name);
      }
    }
  }
  if (!menu || efforts.size === 0) {
    for (const e of taskEfforts) efforts.add(e);
    for (const p of menu?.providers ?? []) for (const m of p.models) for (const e of m.efforts) efforts.add(e);
  }
  if (!menu || providers.size === 0) {
    for (const p of taskProviders) providers.add(p);
    for (const p of menu?.providers ?? []) providers.add(p.name);
  }
  return { models: [...models], efforts: [...efforts], providers: [...providers] };
}

function OverrideDialog({ task, close }: { task: TaskView; close(): void }) {
  const menu = useResource('providers', (signal) => getProviders(signal), { live: false });
  const current = latestRun(task);
  const [model, setModel] = useState(current?.model ?? overrideChoices(task, undefined, '').models[0]?.[0] ?? '');
  const choices = overrideChoices(task, menu.data, model);
  const [effort, setEffort] = useState(current?.effort ?? '');
  const [provider, setProvider] = useState(current?.provider ?? '');
  const [mode, setMode] = useState<'undo' | 'keep'>('undo');
  const action = useAction();
  const { notify } = useApp();
  return (
    <Modal title={`Override ${task.id}`} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action
            .run(() => overrideTask(task.id, { model: model.trim(), mode, ...(effort ? { effort } : {}), ...(provider ? { provider } : {}) }))
            .then((ok) => {
              if (ok) {
                notify(mode === 'undo' ? 'The step starts again on your placement.' : 'Override recorded.');
                close();
              }
            });
        }}
      >
        <fieldset className="pw-override-modes">
          <legend>Mode</legend>
          <label>
            <input type="radio" name="mode" checked={mode === 'undo'} onChange={() => setMode('undo')} />
            Undo: stop the running session and start the step again on this placement
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'keep'} onChange={() => setMode('keep')} />
            Keep: record the override; the running session continues
          </label>
        </fieldset>
        <div className="form-grid">
          <label>
            Model
            <input required aria-label="Model" list="override-models" value={model} onChange={(event) => setModel(event.target.value)} />
            <datalist id="override-models">
              {choices.models.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            Effort
            <select aria-label="Effort" value={effort} onChange={(event) => setEffort(event.target.value)}>
              <option value="">As the policy says</option>
              {choices.efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider
            <select aria-label="Provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="">Any that serves the model</option>
              {choices.providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ErrorLine text={action.error} />
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button disabled={action.busy || !model.trim()}>Override</button>
        </div>
      </form>
    </Modal>
  );
}

function AttachDialog({ task, close }: { task: TaskView; close(): void }) {
  const run = liveRun(task) ?? latestRun(task);
  return (
    <Modal title={`Attach to ${task.id}`} close={close}>
      {run ? (
        <>
          <p>Run this in a terminal on this machine to take the session over; the UI never attaches itself.</p>
          <CommandLine command={`jv attach ${run.id}`} />
          {!LIVE.includes(run.state) && <p className="muted small-text">The newest session {run.id} is {run.state}; jv attach resumes it in a terminal.</p>}
        </>
      ) : (
        <p className="muted">The task has no session yet.</p>
      )}
    </Modal>
  );
}

type Dialog = 'message' | 'answer' | 'stop' | 'override' | 'changes' | 'attach';

function ActionBar({ task, open }: { task: TaskView; open(dialog: Dialog): void }) {
  const live = liveRun(task);
  const latest = latestRun(task);
  const resume = useAction();
  const { notify } = useApp();
  const ended = ['done', 'failed'].includes(task.state);
  const canResume = task.state === 'stopped' || task.state === 'waiting-owner' || latest?.state === 'lost' || latest?.state === 'waiting' || (task.state === 'queued' && !live);
  return (
    <div className="task-actions" role="toolbar" aria-label="Task actions">
      <button type="button" className="secondary" disabled={ended} onClick={() => open('message')}>
        <Icon name="message" size={15} />
        Message
      </button>
      <button type="button" className="secondary" disabled={task.state !== 'waiting-owner'} onClick={() => open('answer')}>
        <Icon name="check" size={15} />
        Answer
      </button>
      {live && (
        <button type="button" className="secondary danger-outline" onClick={() => open('stop')}>
          <Icon name="stop" size={15} />
          Stop
        </button>
      )}
      <button
        type="button"
        className="secondary"
        disabled={!canResume || resume.busy}
        onClick={() => void resume.run(() => resumeTask(task.id)).then((ok) => ok && notify('Resumed.'))}
      >
        <Icon name="play" size={15} />
        Resume
      </button>
      <button type="button" className="secondary" disabled={ended || task.state === 'stopped'} onClick={() => open('override')}>
        <Icon name="tune" size={15} />
        Override
      </button>
      <button type="button" className="secondary" disabled={!task.branch || !task.baseCommit} onClick={() => open('changes')}>
        <Icon name="diff" size={15} />
        Changes
      </button>
      <button type="button" className="secondary" disabled={!latest} onClick={() => open('attach')}>
        <Icon name="terminal" size={15} />
        Attach
      </button>
      {resume.error && <span className="error-text">{resume.error}</span>}
    </div>
  );
}

export function TaskPage({ id }: { id: string }) {
  const task = useResource(`task:${id}`, (signal) => getTask(id, signal));
  const [dialog, setDialog] = useState<Dialog>();
  const { readonly } = useApp();
  const data = task.data;
  useEffect(() => {
    if (data) document.title = `${data.title} · Jevellan`;
    return () => {
      document.title = 'Jevellan';
    };
  }, [data]);
  if (!data) return task.error ? <ErrorLine text={task.error} /> : <Loading />;
  return (
    <div className="task-page">
      <header className="task-header">
        <h1>{data.title}</h1>
        <div className="task-meta">
          <span className="chip mono">{data.id}</span>
          <span className="chip">{data.kind}</span>
          <StateChip state={data.state} />
          <OriginChip origin={data.origin} />
          <RouteLink href={`/p/${encodeURIComponent(data.project)}`} className="chip project-chip">
            {data.project}
          </RouteLink>
          {data.parent && (
            <RouteLink href={`/t/${encodeURIComponent(data.parent)}`} className="chip">
              parent {data.parent}
            </RouteLink>
          )}
          {data.after && (
            <RouteLink href={`/t/${encodeURIComponent(data.after)}`} className="chip">
              after {data.after}
            </RouteLink>
          )}
        </div>
        <p className="task-reason">{data.stateReason}</p>
        <dl className="task-facts">
          <dt>Branch</dt>
          <dd className="mono">{data.branch ?? '-'}</dd>
          <dt>Base</dt>
          <dd className="mono">{short(data.baseCommit) ?? '-'}</dd>
          <dt>Landed</dt>
          <dd className="mono">{short(data.landedCommit) ?? '-'}</dd>
          <dt>Created</dt>
          <dd>
            <Stamp at={data.createdAt} />
          </dd>
        </dl>
      </header>
      {!readonly && <ActionBar task={data} open={setDialog} />}
      <ErrorLine text={task.error} />
      <TaskText text={data.text} />
      <section className="steps" aria-labelledby="steps-heading">
        <h2 id="steps-heading">Steps</h2>
        {data.steps.length === 0 ? (
          <p className="muted">No steps yet.</p>
        ) : (
          <ol className="steps-timeline">
            {data.steps.map((step) => (
              <StepItem key={step.id} step={step} task={data} />
            ))}
          </ol>
        )}
      </section>
      <LandingBlock task={data} />
      {data.children.length > 0 && (
        <section className="card" aria-labelledby="children-heading">
          <h2 id="children-heading">Child tasks</h2>
          <div className="pw-list">
            {data.children.map((child) => (
              <RouteLink key={child.id} href={`/t/${encodeURIComponent(child.id)}`} className="pw-thread-row">
                <StateDot state={child.state} />
                <span className="pw-row-title">
                  <span className="task-id">{child.id}</span> {child.title}
                </span>
                <span className="pw-row-end">{child.state}</span>
              </RouteLink>
            ))}
          </div>
        </section>
      )}
      {data.messages.length > 0 && (
        <details className="card task-messages">
          <summary>
            Messages <span className="pw-count">{data.messages.length}</span>
          </summary>
          <ul>
            {data.messages.map((m) => (
              <li key={m.id}>
                <span className="muted small-text">
                  {m.direction} · <Stamp at={m.createdAt} /> · {m.deliveredAt ? 'delivered' : 'not delivered yet'}
                </span>
                <p>{m.text}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {dialog === 'message' && <MessageDialog task={data} close={() => setDialog(undefined)} />}
      {dialog === 'answer' && <AnswerDialog task={data} close={() => setDialog(undefined)} />}
      {dialog === 'stop' && <StopDialog task={data} close={() => setDialog(undefined)} />}
      {dialog === 'override' && <OverrideDialog task={data} close={() => setDialog(undefined)} />}
      {dialog === 'changes' && <TaskChangesModal taskId={data.id} title={`Changes · ${data.id}`} close={() => setDialog(undefined)} />}
      {dialog === 'attach' && <AttachDialog task={data} close={() => setDialog(undefined)} />}
    </div>
  );
}
