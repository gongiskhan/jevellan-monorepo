// One tick of the bot (brief section 8): the six sub-steps in order; one that throws stops none of the others and
// becomes a log line and meta bot:last_error (redacted, no event); quiet hours (no admissions, schedules skipped,
// lost runs still recovered, through the real reconcile with a fake router and spawn); a due schedule fired through
// the real scheduler into a queued task with origin schedule:<id>; jobs stepped with the improver's handlers, then the
// planner's, creating queued tasks; housekeeping once an hour (the provider probe, gc, the log trim); a stop between
// sub-steps. No model, no Jev, no network.

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { gitRepo, makeHome } from './fixtures/home.js';

const home = makeHome('jv-bot-tick-test-');
process.env.JV_HOME = home;
const SECRET = 'fake-secret-value-TICK0123456789';
writeFileSync(join(home, 'secrets', 'other.key'), `${SECRET}\n`, { mode: 0o600 });

const { ensureMemory } = await import('../src/memory.js');
ensureMemory();
const B = await import('../src/tick.js');
const { defaultBotConfig } = await import('../src/config.js');
const { openBotLog, trimLog } = await import('../src/log.js');
const { openStore } = await import('jevellan-core/store');
const { recordProviderAuth } = await import('jevellan-core/providers');
const { BOT_META } = await import('jevellan-core/bot-state');
const { reconcile: coreReconcile } = await import('jevellan-core/reconcile');
const S = await import('jevellan-scheduler');
const { improverHandlers } = await import('jevellan-improver');
const { plannerHandlers } = await import('jevellan-planner');
type TickDeps = import('../src/tick.js').TickDeps;
type ReconcileDeps = import('jevellan-core/reconcile').ReconcileDeps;
type SessionRow = import('jevellan-core/types').SessionRow;
type ReconcileSummary = import('jevellan-core/reconcile').ReconcileSummary;

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});
for (const p of ['claude-main', 'glm']) recordProviderAuth(store, p, { auth: 'ready', observedAt: new Date().toISOString() });
const repo = gitRepo(join(home, 'repos', 'sandbox'));
const sandbox = store.createProject({ name: 'sandbox', path: repo, default_branch: 'main' }).row;

const logFile = join(home, 'logs', 'bot.log');
const log = openBotLog(logFile);
const logText = () => {
  try {
    return readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
};
const emptyReconcile = (): ReconcileSummary => ({ lost: [], resumed: [], recovered: [], admitted: [], refused: [], delivered: [], woke: 0, errors: [] });
const eventCount = () => (store.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;

/** Deps whose every sub-step records its name and does nothing. */
function recorder(calls: string[], extra: Partial<TickDeps> = {}): Partial<TickDeps> {
  return {
    log,
    heartbeat: (s, beat) => {
      calls.push('heartbeat');
      s.setMeta(BOT_META.tick, String(beat.tick));
    },
    reconcile: async (_s, _l, o) => {
      calls.push(`reconcile admit=${o.admit}`);
      return emptyReconcile();
    },
    tailCoordinator: () => {
      calls.push('coordinator');
      return { projects: [] };
    },
    due: () => {
      calls.push('due');
      return [];
    },
    stepJobs: async (_s, handlers, deps) => {
      calls.push(`jobs ${handlers === improverHandlers ? 'improver' : handlers === plannerHandlers ? 'planner' : '?'} queued=${deps.createTask === B.createQueuedTask}`);
      return { started: [], finished: [], errors: [] };
    },
    probeProviders: async () => {
      calls.push('providers');
      return [];
    },
    gc: async () => {
      calls.push('gc');
      return [];
    },
    trimLog: (file, n) => {
      calls.push(`trim ${n}`);
      return trimLog(file, n);
    },
    ...extra,
  };
}

describe('order and isolation', () => {
  test('the six sub-steps run in the order of section 8; housekeeping runs at the first tick', async () => {
    store.db.prepare("DELETE FROM meta WHERE key = 'bot:housekeeping_at'").run();
    const calls: string[] = [];
    const s = await B.tick(store, defaultBotConfig(), recorder(calls));
    assert.deepEqual(calls, ['heartbeat', 'reconcile admit=true', 'coordinator', 'due', 'jobs improver queued=true', 'jobs planner queued=true', 'providers', 'gc', 'trim 20000']);
    assert.deepEqual(s.steps.map((x) => x.step), [...B.TICK_STEPS]);
    assert.ok(s.steps.every((x) => x.ok));
    assert.deepEqual(s.errors, []);
    assert.ok(s.housekeeping);
  });

  test('a throwing sub-step stops none of the others: a log line and bot:last_error, redacted, and no event', async () => {
    const calls: string[] = [];
    const events = eventCount();
    const s = await B.tick(
      store,
      defaultBotConfig(),
      recorder(calls, {
        reconcile: async () => {
          calls.push('reconcile');
          throw new Error(`the store said no (${SECRET})`);
        },
        tailCoordinator: () => {
          calls.push('coordinator');
          throw new Error('no transcript');
        },
      }),
    );
    assert.deepEqual(calls.slice(0, 5), ['heartbeat', 'reconcile', 'coordinator', 'due', 'jobs improver queued=true']);
    assert.deepEqual(s.steps.map((x) => [x.step, x.ok]), [['heartbeat', true], ['reconcile', false], ['coordinator', false], ['schedules', true], ['jobs', true], ['housekeeping', true]]);
    assert.deepEqual(s.errors.map((e) => e.step), ['reconcile', 'coordinator']);
    const last = JSON.parse(store.getMeta(B.BOT_TICK_META.lastError)!) as { step: string; message: string; at: string };
    assert.equal(last.step, 'coordinator');
    assert.equal(last.message, 'no transcript');
    assert.doesNotMatch(logText(), new RegExp(SECRET));
    assert.match(logText(), /error in reconcile: the store said no \(\[redacted\]\)/);
    assert.ok(s.errors[0]!.message.includes('[redacted]'));
    assert.equal(eventCount(), events, 'an error writes no event');
    assert.equal(store.getMeta(BOT_META.tick), '1');
  });

  test('errors a sub-step reports inside its summary are recorded too; a repeated one is logged once per ten minutes', async () => {
    const before = logText().split('\n').length;
    for (let i = 0; i < 3; i++) {
      await B.tick(store, defaultBotConfig(), recorder([], { reconcile: async () => ({ ...emptyReconcile(), errors: [{ step: 'admit', message: 'T0000AA: worktree gone' }] }) }));
    }
    const lines = logText().split('\n').slice(before - 1).filter((l) => l.includes('worktree gone'));
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(store.getMeta(B.BOT_TICK_META.lastError)!).step, 'reconcile:admit');
  });

  test('a stop requested during a tick lets the running sub-step finish and skips the rest', async () => {
    let stop = false;
    const calls: string[] = [];
    const s = await B.tick(
      store,
      defaultBotConfig(),
      recorder(calls, {
        stopping: () => stop,
        reconcile: async () => {
          calls.push('reconcile');
          stop = true;
          return emptyReconcile();
        },
      }),
    );
    assert.deepEqual(calls, ['heartbeat', 'reconcile']);
    assert.equal(s.stopped, true);
    assert.deepEqual(s.steps.filter((x) => x.skipped === 'stopping').map((x) => x.step), ['coordinator', 'schedules', 'jobs', 'housekeeping']);
  });
});

describe('housekeeping', () => {
  test('once an hour: not due within the hour, due again after it; the log is trimmed to logLines', async () => {
    const t0 = new Date('2026-11-02T10:00:00.000Z');
    store.db.prepare("DELETE FROM meta WHERE key = 'bot:housekeeping_at'").run();
    const at = (ms: number) => recorder([], { now: () => new Date(t0.getTime() + ms) });
    const first = await B.tick(store, { ...defaultBotConfig(), logLines: 100 }, at(0));
    assert.ok(first.housekeeping);
    assert.equal(store.getMeta(B.BOT_TICK_META.housekeepingAt), t0.toISOString());
    const soon = await B.tick(store, defaultBotConfig(), at(59 * 60_000));
    assert.equal(soon.housekeeping, null);
    assert.equal(soon.steps.find((x) => x.step === 'housekeeping')?.skipped, 'not due');
    writeFileSync(logFile, Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const later = await B.tick(store, { ...defaultBotConfig(), logLines: 100 }, at(61 * 60_000));
    assert.deepEqual(later.housekeeping?.log, { before: 250, after: 100 });
    const kept = logText().trim().split('\n');
    assert.equal(kept[0], 'line 150');
    assert.match(kept.at(-1)!, /housekeeping: providers probed: none ready; gc: nothing; bot\.log trimmed from 250 to 100 lines/);
  });

  test('a failing part of housekeeping stops neither the others nor the tick', async () => {
    store.db.prepare("DELETE FROM meta WHERE key = 'bot:housekeeping_at'").run();
    const calls: string[] = [];
    const s = await B.tick(
      store,
      defaultBotConfig(),
      recorder(calls, {
        probeProviders: async () => {
          throw new Error('probe failed');
        },
      }),
    );
    assert.ok(calls.includes('gc') && calls.some((c) => c.startsWith('trim')));
    assert.deepEqual(s.errors.map((e) => e.step), ['housekeeping:providers']);
  });
});

describe('the real sub-steps', () => {
  // A fake router and spawn for the real reconcile: a placement row, and a run that is running at once.
  const dead = new Set<string>();
  const placed: string[] = [];
  const spawned: string[] = [];
  const fakeDeps: Partial<ReconcileDeps> = {
    placeStep: async (input) => {
      placed.push(input.taskId);
      const task = store.requireTask(input.taskId);
      const decision = store.createDecision({
        kind: 'placement',
        project_id: task.project_id,
        task_id: task.id,
        step_id: input.stepId,
        skill_name: 'jevellan-router',
        skill_hash: 'hash',
        jev_model: 'jev-test',
        state_json: '{}',
        questions_json: '{}',
        answers_json: '{}',
        chosen_json: '{}',
        latency_ms: 1,
        usage_json: '{}',
      });
      return { runtime: 'claude-sdk', provider: 'claude-main', model: 'model-strong', effort: 'high', decisionId: decision.id, decision };
    },
    spawn: (s, id) => {
      spawned.push(id);
      const row = s.requireSession(id);
      s.setSessionState(id, 'running', 'fake turn', { pid: 4242, ...(row.native_session_id ? {} : { native_session_id: `native-${id}` }) });
    },
    notify: async () => {},
    alive: (s: SessionRow) => !dead.has(s.id),
    pidAlive: () => false,
    limits: () => ({ perProject: 10, total: 10 }),
  };
  const realReconcile: TickDeps['reconcile'] = (s, limits, o) => coreReconcile(s, limits, { ...o, deps: fakeDeps });
  let n = 0;
  const queuedTask = (title: string) => {
    const t = store.createTask({
      project_id: sandbox.id,
      request_id: `bot-tick-${++n}`,
      kind: 'single',
      title,
      task_text: 'Do the thing.',
      workflow_json: JSON.stringify({ name: 'single', steps: [{ duty: 'implement', when: 'always', instructions: '' }] }),
    }).row;
    store.createStep({ task_id: t.id, ordinal: 1, duty: 'implement' });
    return store.updateTask(t.id, { worktree_path: join(home, 'worktrees', `t${n}`), branch: `jv/t-${n}`, base_commit: 'a'.repeat(40) });
  };
  const quiet = () => {
    const now = new Date();
    const hh = (h: number) => String((h + 24) % 24).padStart(2, '0');
    return { ...defaultBotConfig(), quietHours: { from: `${hh(now.getHours() - 2)}:00`, to: `${hh(now.getHours() + 2)}:00` } };
  };

  test('quiet hours: no admission and the schedule is skipped, while a lost run is still resumed on its native session', async () => {
    const running = queuedTask('Running before the quiet hours');
    const normal = await B.tick(store, defaultBotConfig(), { log, reconcile: realReconcile, probeProviders: async () => [], gc: async () => [] });
    assert.deepEqual(normal.reconcile?.admitted, [running.id]);
    const run = store.listSessions({ task_id: running.id, kind: 'step' }).at(-1)!;
    assert.equal(run.state, 'running');
    dead.add(run.id);

    const waiting = queuedTask('Queued during the quiet hours');
    const schedule = S.addSchedule(store, { project: 'sandbox', name: 'Every minute', cron: '* * * * *', kind: 'task', task: { kind: 'single', duty: 'implement', title: 'Minute job', text: 'Run it.' } }, new Date(Date.now() - 5 * 60_000));
    placed.length = 0;
    const q = await B.tick(store, quiet(), { log, reconcile: realReconcile, probeProviders: async () => [], gc: async () => [] });
    assert.equal(q.quiet, true);
    assert.deepEqual(q.reconcile?.lost, [run.id]);
    assert.equal(q.reconcile?.recovered[0]?.action, 'resumed');
    const resumed = store.getSession(q.reconcile!.resumed[0]!)!;
    assert.equal(resumed.native_session_id, run.native_session_id, 'the resume turn continues the same native session');
    assert.deepEqual(q.reconcile?.admitted, []);
    assert.equal(store.requireTask(waiting.id).state, 'queued');
    assert.ok(!placed.includes(waiting.id), 'no placement for the queued task');
    assert.deepEqual(q.schedules, [{ schedule: schedule.id, name: 'Every minute', result: 'skipped: quiet hours', late: true }]);
    assert.equal(S.requireSchedule(store, schedule.id).last_result, 'skipped: quiet hours');
    assert.equal(store.listTasks({}).filter((t) => t.origin === `schedule:${schedule.id}`).length, 0);
    assert.match(logText(), /quiet hours \d\d:00-\d\d:00 began: no admissions and no schedules/);
    S.pause(store, S.requireSchedule(store, schedule.id));
    // Leave nothing running for the next test.
    for (const s of store.listSessions({ states: ['running'] })) store.setSessionState(s.id, 'done', 'test cleanup');
    for (const t of store.listTasks({ states: ['queued', 'running'] })) store.setTaskState(t.id, 'stopped', 'test cleanup');
  });

  test('a due task schedule creates a queued task with origin schedule:<id>; the next tick admits it', async () => {
    // One fixed time for both ticks, so the second is never in the next minute.
    const fixed = new Date();
    const s = S.addSchedule(store, { project: 'sandbox', name: 'Nightly', cron: '* * * * *', kind: 'task', task: { kind: 'single', duty: 'implement', title: 'Nightly', text: 'Run the tests.' } }, new Date(fixed.getTime() - 90_000));
    placed.length = 0;
    const t1 = await B.tick(store, defaultBotConfig(), { log, now: () => fixed, reconcile: realReconcile, probeProviders: async () => [], gc: async () => [] });
    const fired = t1.schedules.find((x) => x.schedule === s.id)!;
    assert.match(fired.result, /^created T[0-9A-Z]{6}$/);
    const task = store.requireTask(fired.task!);
    assert.equal(task.origin, `schedule:${s.id}`);
    assert.equal(task.state, 'queued', 'created queued: the admission is the next tick');
    assert.equal(S.requireSchedule(store, s.id).last_result, fired.result);
    assert.equal(placed.length, 0, 'no placement in the tick that created it');
    assert.match(logText(), new RegExp(`schedule ${s.id} "Nightly": created ${task.id}`));
    const t2 = await B.tick(store, defaultBotConfig(), { log, now: () => fixed, reconcile: realReconcile, probeProviders: async () => [], gc: async () => [] });
    assert.deepEqual(t2.reconcile?.admitted, [task.id]);
    assert.deepEqual(t2.schedules, [], 'not due again within the minute');
    S.pause(store, S.requireSchedule(store, s.id));
    for (const x of store.listSessions({ states: ['running'] })) store.setSessionState(x.id, 'done', 'test cleanup');
    for (const t of store.listTasks({ states: ['queued', 'running'] })) store.setTaskState(t.id, 'stopped', 'test cleanup');
  });

  test('a queued job gets its work task, queued, through the bot\'s task creator', async () => {
    const job = store.createJob({ project_id: sandbox.id, kind: 'improve-docs', request_id: 'bot-tick-job', input_json: '{}' }).row;
    const t = await B.tick(store, defaultBotConfig(), { log, reconcile: async () => emptyReconcile(), probeProviders: async () => [], gc: async () => [] });
    const started = t.jobs.started.find((x) => x.job === job.id)!;
    assert.ok(started, JSON.stringify(t.jobs));
    const task = store.requireTask(started.task);
    assert.equal(task.origin, `improver:${job.id}`);
    assert.equal(task.state, 'queued');
    assert.equal(store.getJob(job.id)!.state, 'running');
    assert.match(logText(), new RegExp(`job ${job.id} started its task ${task.id}`));
  });
});
