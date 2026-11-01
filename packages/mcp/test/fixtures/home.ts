// Fixture of the jevellan-mcp tests: a temporary JV_HOME (made-up secrets and providers.json, the duty, workflow,
// router and coordinator skills of core's skills fixture), a git repository registered as project "sandbox", a store
// with tasks in several states, runs with events and a needs-decision report, memories, provider usage, a schedule,
// goals and jobs; plus the fakes that let jv_task_create run without a model (placement, spawn, wake, landing) and
// the command line's main() run in this process for --json comparisons. Every value is made up. Callers set
// process.env.JV_HOME (makeHome) before they import anything else.

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FAKE_TOKEN = 'fake-oauth-token-MCPTEST0123456789';

/** A new temporary JV_HOME with providers, secrets and skills; also sets process.env.JV_HOME. */
export function makeHome(prefix: string, coreRoot?: string): string {
  const home = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  process.env.JV_HOME = home;
  mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'secrets', 'claude-main.token'), `${FAKE_TOKEN}\n`, { mode: 0o600 });
  mkdirSync(join(home, 'homes', 'claude-main'), { recursive: true });
  writeFileSync(
    join(home, 'providers.json'),
    JSON.stringify(
      {
        jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-test' },
        providers: [
          {
            name: 'claude-main',
            kind: 'claude-subscription',
            home: '~/.jv/homes/claude-main',
            tokenFile: '~/.jv/secrets/claude-main.token',
            models: [
              { id: 'model-strong', label: 'Strong', efforts: ['low', 'medium', 'high'] },
              { id: 'claude-opus-5-5', label: 'Coordinator', efforts: ['high'] },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
  // Wide limits: the fake spawn leaves runs starting, so every created task would keep its slot.
  writeFileSync(join(home, 'bot.json'), JSON.stringify({ limits: { perProject: 100, total: 100 } }));
  if (coreRoot) {
    const skills = join(coreRoot, 'test', 'fixtures', 'skills');
    for (const name of ['jevellan-coordinator', 'jevellan-router', 'jevellan-landing', 'jevellan-workflow-feature', 'jevellan-workflow-bug', 'jevellan-workflow-automation']) {
      cpSync(join(skills, name), join(home, 'skills', name), { recursive: true });
    }
    for (const duty of ['answer', 'converse', 'investigate', 'plan', 'implement', 'document', 'verify', 'automate']) {
      const dir = join(home, 'skills', `jevellan-duty-${duty}`);
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(skills, `jevellan-duty-${duty}`, 'SKILL.md'), join(dir, 'SKILL.md'));
    }
  }
  return home;
}

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

/** A git repository with one commit on main. */
export function makeRepo(home: string, name = 'sandbox'): string {
  const repo = join(home, 'repos', name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  return repo;
}

type Store = import('jevellan-core/store').Store;

export interface StoreFixture {
  projectId: string;
  repo: string;
  /** A done single task with a run, events and a needs-decision report. */
  asked: string;
  askedRun: string;
  /** A queued feature task. */
  queued: string;
  /** A run whose payload holds a text longer than the tail cut. */
  longRun: string;
  memory: string;
  schedule: string;
  goal: string;
  job: string;
}

/** Fills the store of the current JV_HOME (see the header). */
export async function buildFixture(store: Store, home: string): Promise<StoreFixture> {
  const { recordEvent } = await import('jevellan-core/events');
  const { writeReport } = await import('jevellan-core/report');
  const memory = await import('jevellan-memory');
  const { addSchedule } = await import('jevellan-scheduler');
  const { addGoal, plannerHandlers } = await import('jevellan-planner');
  const { createJob } = await import('jevellan-core/jobs');

  const repo = makeRepo(home);
  const project = store.createProject({ name: 'sandbox', path: repo, default_branch: 'main' }).row;
  let req = 0;
  const task = (kind: 'single' | 'feature', title: string, text: string) =>
    store.createTask({ project_id: project.id, request_id: `mcp-fixture-${++req}`, kind, title, task_text: text, workflow_json: JSON.stringify({ name: kind, steps: [] }) }).row;

  const asked = task('single', 'Which colour for the button', 'Ask the owner which colour the button gets.');
  const askedStep = store.createStep({ task_id: asked.id, ordinal: 1, duty: 'investigate', instructions: 'Ask.' }).row;
  const askedRun = store.createSession({
    project_id: project.id,
    task_id: asked.id,
    step_id: askedStep.id,
    request_id: `mcp-fixture-run-${++req}`,
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: repo,
  }).row;
  store.setSessionState(askedRun.id, 'running', 'running', { native_session_id: 'native-fixture-1' });
  recordEvent(store, askedRun.id, 'start', { runtime: 'claude-sdk', provider: 'claude-main', model: 'model-strong', effort: 'high', cwd: repo });
  recordEvent(store, askedRun.id, 'text', { text: 'Looking at the button styles.' });
  recordEvent(store, askedRun.id, 'tool-call', { id: 'call-1', name: 'Read', input: '{"file":"README.md"}' });
  recordEvent(store, askedRun.id, 'tool-result', { id: 'call-1', ok: true, output: '# sandbox' });
  writeReport(store, askedRun.id, {
    status: 'needs-decision',
    summary: 'The button can be blue or green.',
    question: 'Which colour?',
    options: [{ label: 'Blue' }, { label: 'Green', description: 'Matches the logo.' }],
    changedFiles: [],
    screenshots: [],
  });
  recordEvent(store, askedRun.id, 'end', { status: 'done' });
  store.setSessionState(askedRun.id, 'done', 'turn ended');
  store.setStepState(askedStep.id, 'running', 'waiting on the owner');
  store.setTaskState(asked.id, 'waiting-owner', 'step 1 (investigate): needs a decision');

  const queued = task('feature', 'Customers empty state', 'Show a message when there are no customers.');
  store.createStep({ task_id: queued.id, ordinal: 1, duty: 'implement', instructions: '' });

  const longTask = task('single', 'A long answer', 'Answer at length.');
  const longStep = store.createStep({ task_id: longTask.id, ordinal: 1, duty: 'answer', instructions: '' }).row;
  const longRun = store.createSession({
    project_id: project.id,
    task_id: longTask.id,
    step_id: longStep.id,
    request_id: `mcp-fixture-run-${++req}`,
    kind: 'step',
    runtime: 'llm',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'low',
    cwd: repo,
  }).row;
  recordEvent(store, longRun.id, 'text', { text: 'x'.repeat(5000) });
  for (let i = 0; i < 4; i++) recordEvent(store, longRun.id, 'text', { text: `line ${i}` });
  store.setSessionState(longRun.id, 'done', 'turn ended');
  store.setTaskState(longTask.id, 'done', 'answered');

  store.recordProviderUsage({ provider: 'claude-main', source: 'probe', five_hour_pct: 12, weekly_pct: 40 });

  const m = memory.remember(store.db, { scope: memory.projectScope('sandbox'), kind: 'environment', text: 'The sandbox tests need npm ci first', tags: ['tests'], source: 'owner' });
  memory.remember(store.db, { scope: memory.GLOBAL_SCOPE, kind: 'preference', text: 'Short commit messages that say why', tags: [], source: 'owner' });

  const schedule = addSchedule(store, { project: 'sandbox', name: 'Nightly plan', cron: '30 3 * * *', tz: 'Europe/Lisbon', kind: 'job', job: 'plan' });
  const goal = addGoal(store, { project: 'sandbox', title: 'Customers can import a CSV', text: 'Import contacts from a CSV and see errors per row.', priority: 2 });
  addGoal(store, { project: 'sandbox', title: 'Faster tests', text: 'The unit tests run in under a minute.' });
  const job = createJob(store, plannerHandlers, { project: 'sandbox', kind: 'plan' }).job;

  return { projectId: project.id, repo, asked: asked.id, askedRun: askedRun.id, queued: queued.id, longRun: longRun.id, memory: m.id, schedule: schedule.id, goal: goal.id, job: job.id };
}

/** The command line's main(), loaded from the built jevellan-cli (its setup registers jevellan-memory). */
export async function loadCli(coreRoot: string): Promise<(argv: string[]) => Promise<number>> {
  const file = join(coreRoot, '..', 'cli', 'dist', 'cli.js');
  const mod = (await import(pathToFileURL(file).href)) as { main(argv: string[]): Promise<number> };
  return (argv) => mod.main(argv);
}

/** Runs `jv <argv> --json` in this process and parses what it printed (a JSON document, or JSON lines). */
export async function cliJson(main: (argv: string[]) => Promise<number>, argv: string[], options: { lines?: boolean } = {}): Promise<{ code: number; json: unknown }> {
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await main([...argv, '--json']);
  } finally {
    process.stdout.write = write;
  }
  const text = out.join('');
  const json = options.lines
    ? text
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as unknown)
    : (JSON.parse(text) as unknown);
  return { code, json };
}

/** The fakes of jevellan-core's TaskDeps that create and start tasks without Jev or a model. */
export function fakeTaskDeps(store: Store): Partial<import('jevellan-core/tasks').TaskDeps> & { spawned: string[] } {
  const spawned: string[] = [];
  return {
    spawned,
    placeStep: async (input) => {
      const step = store.requireStep(input.stepId);
      const task = store.requireTask(input.taskId);
      const decision = store.createDecision({
        kind: 'placement',
        project_id: task.project_id,
        task_id: task.id,
        step_id: step.id,
        skill_name: 'jevellan-router',
        skill_hash: 'hash',
        jev_model: 'jev-test',
        state_json: '{}',
        questions_json: '{}',
        answers_json: '{}',
        chosen_json: JSON.stringify({ duty: step.duty, model: 'model-strong', effort: 'high' }),
        latency_ms: 1,
        usage_json: '{}',
      });
      return { runtime: 'claude-sdk', provider: 'claude-main', model: 'model-strong', effort: 'high', decisionId: decision.id, decision };
    },
    askWorkflowQuestions: async () => {
      throw new Error('no workflow questions in these tests');
    },
    spawn: (_s, id) => {
      spawned.push(id);
    },
    notify: async () => undefined,
    stopRun: async (s, id, reason) => s.setSessionState(id, 'stopped', reason),
    land: async (_s, taskId) => ({ route: 'land', state: 'landed', reason: 'fake', taskId }),
    probeLogins: async (names) => names.map((n) => ({ name: `login:${n}`, status: 'OK', line: `OK login:${n}` })),
  };
}

/** Reads a file (for the log assertions). */
export function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
