// M6 UI actions (brief section 14), with the real providers and Jev in a temporary JV_HOME (lib.mjs realJvHome; Codex
// disabled there, D-022), on the sandbox clone ~/jevellan-projects/jv-mono-sandbox-clone: the step commits on its
// branch, and a journey never dirties the main sandbox (M5's rule). A `single` task never lands (advance.ts: after its
// last step a single task is done), so the clone's main is untouched; only the task's jv/... branch stays.
//
// 1. A single implement task whose text tells the step, in order, to commit notes/m06-committed.txt, create
//    notes/m06-uncommitted.txt and leave it uncommitted, then report needs-decision "Which colour?" with the options
//    Blue and Green; after the answer, to run `sleep 45` (a slow check, so the answer turn is live long enough for the
//    action bar), write the colour into notes/colour.txt, commit and report done.
// 2. In the browser (1280 by 800): the task page shows the question with Blue and Green as buttons (screenshot); the
//    Changes modal lists the committed file with its diff against the base and the uncommitted file marked
//    "uncommitted" (screenshot).
// 3. Clicking Blue posts the answer: a messages row direction answer "Blue" and a new run on the same native session.
// 4. While that turn runs, the action bar's Stop stops it (the run stopped, the task's reason says resume continues
//    it); Override offers the providers.json menu (GET /api/providers, M-068) and records the owner's placement in
//    mode keep on the step's placement decision; Resume starts a turn on the same native session.
// 5. The step finishes with notes/colour.txt on the branch saying Blue.
//
// Usage: node acceptance/m06-ui-actions.mjs [--keep] [--timeout-min 20]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m06.json and acceptance/shots/m06-*.png.

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  cleanup,
  ensureSandboxClone,
  finish,
  git,
  jvJson,
  leakCheck,
  log,
  note,
  parseFlags,
  query,
  queryOne,
  realJvHome,
  removeWorktreesUnder,
  runDir,
  runId,
  runJourney,
  SANDBOX_CLONE,
  SANDBOX_CLONE_NAME,
  SHOTS_DIR,
  startUi,
  stopChild,
  storeFile,
  uiPage,
  waitFor,
  waitForTask,
} from './lib.mjs';

const JOURNEY = 'm06';
const USAGE = 'node acceptance/m06-ui-actions.mjs [--keep] [--timeout-min 20]';
const MODE = 'real providers in a temporary JV_HOME, the sandbox clone, jv ui in headless Chromium';

const COMMITTED = 'notes/m06-committed.txt';
const COMMITTED_LINE = 'committed before the question';
const UNCOMMITTED = 'notes/m06-uncommitted.txt';
const UNCOMMITTED_LINE = 'left uncommitted until the answer';
const COLOUR = 'notes/colour.txt';
const QUESTION = 'Which colour?';

const TEXT = [
  'This task checks how a step asks the owner a question. Do exactly these steps, in this order, and change nothing else in the repository: no code changes, so there are no tests to add or run.',
  `1. Create the file ${COMMITTED} whose only line is \`${COMMITTED_LINE}\`, and commit it on this branch with the message "Add the committed note".`,
  `2. Create the file ${UNCOMMITTED} whose only line is \`${UNCOMMITTED_LINE}\`. Do not stage it and do not commit it yet.`,
  `3. End this turn with a jv_report of status needs-decision whose question is exactly "${QUESTION}" and whose options are exactly two, with the labels "Blue" and "Green". Do not choose a colour yourself.`,
  `4. When the owner has answered: first run the shell command \`sleep 45\` and wait for it to finish (it stands in for a slow check), then create ${COLOUR} whose only line is the colour the owner chose, commit ${UNCOMMITTED} and ${COLOUR} with the message "Record the chosen colour", and report done with a summary that names the colour.`,
].join('\n');

const ENDED = ['done', 'failed', 'stopped'];
const RUN_ENDED = ['done', 'failed', 'lost', 'stopped'];

function runs(home, taskId) {
  return query(
    storeFile(home),
    "SELECT id, state, state_reason, request_id, native_session_id, pid, runtime, provider, model, effort, step_id, started_at FROM sessions WHERE task_id = ? AND kind = 'step' ORDER BY rowid",
    taskId,
  );
}

/** providers.json of a home, with "same as <name>" model lists resolved as core resolves them. */
function providersFile(home) {
  const providers = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8')).providers ?? [];
  const byName = new Map(providers.map((p) => [p.name, p]));
  const models = (p, seen = new Set()) => {
    const m = typeof p.models === 'string' ? /^same as (\S+)$/.exec(p.models) : null;
    if (!m) return Array.isArray(p.models) ? p.models : [];
    if (seen.has(p.name) || !byName.has(m[1])) return [];
    return models(byName.get(m[1]), new Set([...seen, p.name]));
  };
  return providers.map((p) => ({ ...p, models: models(p) }));
}

function taskRow(home, taskId) {
  return queryOne(storeFile(home), 'SELECT id, state, state_reason, branch, base_commit, worktree_path FROM tasks WHERE id = ?', taskId);
}

/** A POST the page makes to `path`, with its JSON body, once `action` ran. */
async function postOf(page, path, action) {
  const [request] = await Promise.all([page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === path, { timeout: 20_000 }), action()]);
  const response = await request.response();
  return { body: request.postDataJSON(), status: response?.status(), answer: await response?.json().catch(() => undefined) };
}

/** Whether a process with this pid exists (EPERM counts: it exists, it is someone else's). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { values: ['timeout-min'], usage: USAGE });
  const timeoutMs = Number(flags['timeout-min'] ?? 20) * 60_000;
  const started = Date.now();
  const id = runId(JOURNEY);
  ensureSandboxClone();
  log(`M6 UI actions ${id}`);
  const shotsRun = join(runDir(id), 'shots');
  mkdirSync(shotsRun, { recursive: true });
  let home;
  let ui;
  let browser;
  let taskId;
  // The checks run in an inner function so that an early end still goes through the finally block (the task stopped,
  // the worktree removed, the clone checked) before finish() records the result.
  const journey = async () => {
    const setup = realJvHome(id, { projects: [[SANDBOX_CLONE, SANDBOX_CLONE_NAME]] });
    home = setup.home;
    note(`temporary home ${home}; codex disabled: ${setup.seeded.disabled.join(', ') || 'none'}`);

    await check('jv task create --kind single --duty implement on the sandbox clone', () => {
      const r = jvJson(['task', 'create', '--project', SANDBOX_CLONE_NAME, '--kind', 'single', '--duty', 'implement', '--title', 'Ask the owner which colour', '--text', TEXT], { home, timeoutMs: 300_000 });
      taskId = r.json?.task?.id;
      return { ok: r.code === 0 && !!taskId, detail: r.code === 0 ? `${taskId}: ${r.json.start?.state ?? ''} ${r.json.start?.session?.id ?? ''}` : r.stderr || r.stdout };
    });
    if (!taskId) return;

    let asked;
    await check('the step reports needs-decision "Which colour?" with the options Blue and Green and the task waits on the owner', async () => {
      const end = await waitForTask(home, taskId, ['waiting-owner', ...ENDED], { timeoutMs: 15 * 60_000 });
      const last = runs(home, taskId).at(-1);
      const report = last ? queryOne(storeFile(home), 'SELECT status, question, options_json, summary FROM reports WHERE session_id = ?', last.id) : undefined;
      const labels = report?.options_json ? JSON.parse(report.options_json).map((o) => o.label) : [];
      asked = last && report ? { run: last, report, labels } : undefined;
      const t = taskRow(home, taskId);
      const ok = end?.state === 'waiting-owner' && report?.status === 'needs-decision' && report.question?.trim() === QUESTION && labels.join('|') === 'Blue|Green';
      return { ok, detail: `${taskId} ${end?.state}: ${t?.state_reason}; run ${last?.id} on ${last?.runtime} (${last?.provider}, ${last?.model} ${last?.effort}) native ${last?.native_session_id ?? 'none'}; report ${report?.status}: ${JSON.stringify(report?.question ?? null)} ${JSON.stringify(labels)}` };
    });
    if (!asked) return;
    note(`Jev placed the step on ${asked.run.runtime} (${asked.run.provider}, ${asked.run.model} ${asked.run.effort})`);

    ui = await startUi(home);
    const signedIn = await uiPage(ui);
    browser = signedIn.browser;
    const page = signedIn.page;
    const toolbar = page.getByRole('toolbar', { name: 'Task actions' });
    const options = page.getByRole('group', { name: 'Options' });

    await check('/t/<id> shows the question with Blue and Green as buttons', async () => {
      await page.goto(`${ui.url}/t/${taskId}`);
      await options.waitFor({ timeout: 20_000 });
      const labels = (await options.getByRole('button').allTextContents()).map((s) => s.trim());
      const question = await page.locator('.pw-question').first().innerText();
      // The page scrolls inside the shell, so the shot is of the viewport with the report in the middle.
      await page.locator('.pw-report').last().evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: join(shotsRun, 'needs-decision.png') });
      const ok = labels.some((l) => l.startsWith('Blue')) && labels.some((l) => l.startsWith('Green')) && labels.length === 2 && question.trim() === QUESTION;
      return { ok, detail: `question ${JSON.stringify(question.trim())}; buttons ${JSON.stringify(labels)}` };
    });

    await check('the Changes modal shows the committed diff against the base and the uncommitted file marked', async () => {
      const t = taskRow(home, taskId);
      const committedOnBranch = git(SANDBOX_CLONE, ['diff', '--name-only', `${t.base_commit}...refs/heads/${t.branch}`]).split('\n').filter(Boolean);
      await toolbar.getByRole('button', { name: 'Changes' }).click();
      const dialog = page.getByRole('dialog', { name: `Changes · ${taskId}` });
      const list = dialog.getByRole('list', { name: 'Changed files' });
      await list.waitFor({ timeout: 20_000 });
      const bar = (await dialog.locator('.worktree-changes-bar > span').innerText()).trim();
      const row = (path) => list.getByRole('button').filter({ hasText: path });
      const rowText = async (path) => (await row(path).innerText()).replace(/\s+/g, ' ').trim();
      /** Selects a file and returns the diff's label and its added lines. */
      const select = async (path, label, line) => {
        await row(path).click();
        await list.locator('button[aria-current="true"]', { hasText: path }).waitFor({ timeout: 10_000 });
        await dialog.locator('.diff-label', { hasText: label }).waitFor({ timeout: 10_000 });
        await dialog.locator('.diff-line.addition code', { hasText: line }).first().waitFor({ timeout: 10_000 });
        return { label: (await dialog.locator('.diff-label').innerText()).trim(), added: await dialog.locator('.diff-line.addition code').allInnerTexts() };
      };
      const committedText = await rowText(COMMITTED);
      const uncommittedText = await rowText(UNCOMMITTED);
      const u = await select(UNCOMMITTED, `${UNCOMMITTED} (uncommitted)`, UNCOMMITTED_LINE);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(400); // the rows' 0.15 s colour transition
      await page.screenshot({ path: join(shotsRun, 'changes-uncommitted.png') });
      const c = await select(COMMITTED, COMMITTED, COMMITTED_LINE);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(shotsRun, 'changes-committed.png') });
      await dialog.getByRole('button', { name: 'Close' }).click();
      await dialog.waitFor({ state: 'hidden' });
      const ok =
        committedOnBranch.includes(COMMITTED) &&
        !committedOnBranch.includes(UNCOMMITTED) &&
        /^A ?notes\/m06-committed\.txt ?\+1 ?-0$/.test(committedText) &&
        /^A ?notes\/m06-uncommitted\.txt ?uncommitted ?\+1 ?-0$/.test(uncommittedText) &&
        c.label === COMMITTED &&
        c.added.includes(`+${COMMITTED_LINE}`) &&
        u.label === `${UNCOMMITTED} (uncommitted)` &&
        u.added.includes(`+${UNCOMMITTED_LINE}`) &&
        /\b1 uncommitted\b/.test(bar);
      return { ok, detail: `bar "${bar}"; rows "${committedText}" and "${uncommittedText}"; diffs ${JSON.stringify(c.added)} and ${JSON.stringify(u.added)} ("${u.label}"); git diff base...branch: ${committedOnBranch.join(', ')}` };
    });

    let answerRun;
    await check('clicking Blue records jv task answer and the step continues on the same native session', async () => {
      const post = await postOf(page, `/api/tasks/${taskId}/answer`, () => options.getByRole('button', { name: /^Blue/ }).click());
      await page.getByText('Sent: Blue').waitFor({ timeout: 10_000 });
      const message = queryOne(storeFile(home), 'SELECT id, direction, text FROM messages WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId);
      answerRun = message ? runs(home, taskId).find((r) => r.request_id === `answer:${message.id}`) : undefined;
      const ok = post.status === 200 && post.body?.answer === 'Blue' && message?.direction === 'answer' && message.text === 'Blue' && !!answerRun && answerRun.native_session_id === asked.run.native_session_id;
      return { ok, detail: `POST ${JSON.stringify(post.body)} -> ${post.status}; message ${message?.id} ${message?.direction} ${JSON.stringify(message?.text)}; run ${answerRun?.id ?? 'none'} (${answerRun?.request_id ?? ''}) native ${answerRun?.native_session_id ?? '-'}` };
    });
    if (!answerRun) return;

    await check('Stop from the action bar stops the running turn; the task says resume continues it', async () => {
      const live = await waitFor(() => {
        const r = runs(home, taskId).find((x) => x.id === answerRun.id);
        return r && ((r.state === 'running' && r.pid) || RUN_ENDED.includes(r.state)) ? r : undefined;
      }, { timeoutMs: 120_000, intervalMs: 500 });
      if (live?.state !== 'running') return { ok: false, detail: `the answer turn ${answerRun.id} is ${live?.state ?? 'not running'} (${live?.state_reason ?? ''})` };
      const stop = toolbar.getByRole('button', { name: 'Stop' });
      await stop.waitFor({ timeout: 15_000 });
      await stop.click();
      const dialog = page.getByRole('dialog', { name: `Stop ${taskId}` });
      const post = await postOf(page, `/api/tasks/${taskId}/stop`, () => dialog.getByRole('button', { name: 'Stop', exact: true }).click());
      const r = runs(home, taskId).find((x) => x.id === answerRun.id);
      const t = taskRow(home, taskId);
      const end = queryOne(storeFile(home), "SELECT payload FROM events WHERE session_id = ? AND kind = 'end' ORDER BY id DESC LIMIT 1", answerRun.id);
      await toolbar.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 15_000 });
      // The run's process really ends: jv signals a group only when it can show it is the run's (M-087), and a stop
      // that left the turn running would race the resume below.
      const gone = await waitFor(() => (pidAlive(live.pid) ? undefined : true), { timeoutMs: 15_000, intervalMs: 250 });
      const ok = post.status === 200 && JSON.stringify(post.body) === '{}' && r?.state === 'stopped' && r.state_reason === 'stopped by the owner' && t?.state === 'running' && t.state_reason.includes(`jv task resume ${taskId} continues`) && !!gone;
      return { ok, detail: `POST ${JSON.stringify(post.body)} -> ${post.status}; run ${r?.id} ${r?.state} (${r?.state_reason}); its process ${live.pid} ${gone ? 'ended' : 'still running'}; end event ${end?.payload ?? 'none'}; task ${t?.state}: ${t?.state_reason}` };
    });

    await check('Override offers the providers.json menu and records the pick on the step (mode keep)', async () => {
      const before = runs(home, taskId).length;
      const [menuResponse] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === '/api/providers' && r.request().method() === 'GET', { timeout: 20_000 }),
        toolbar.getByRole('button', { name: 'Override' }).click(),
      ]);
      const menu = await menuResponse.json();
      const dialog = page.getByRole('dialog', { name: `Override ${taskId}` });
      await dialog.waitFor();
      // The menu is providers.json's enabled providers with their models (M-068), and every model is suggested.
      const enabled = providersFile(home).filter((p) => p.enabled !== false);
      const menuMatches = JSON.stringify(menu.providers.map((p) => [p.name, p.models.map((m) => m.id)])) === JSON.stringify(enabled.map((p) => [p.name, p.models.map((m) => m.id)]));
      const menuIds = menu.providers.flatMap((p) => p.models.map((m) => m.id));
      await waitFor(async () => {
        const ids = await dialog.locator('#override-models option').evaluateAll((os) => os.map((o) => o.getAttribute('value')));
        return menuIds.every((m) => ids.includes(m));
      }, { timeoutMs: 10_000, intervalMs: 200 });
      const suggested = await dialog.locator('#override-models option').evaluateAll((os) => os.map((o) => o.getAttribute('value')));
      // A model of the menu other than the one running, with an effort and the provider the menu gives for it.
      const provider = menu.providers.find((p) => p.name === answerRun.provider) ?? menu.providers[0];
      const model = provider.models.find((m) => m.id !== answerRun.model) ?? provider.models[0];
      const effort = model.efforts.includes('low') ? 'low' : model.efforts[0];
      await dialog.getByLabel('Keep: record the override; the running session continues').check();
      await dialog.getByLabel('Model').fill(model.id);
      const wantedEfforts = ['As the policy says', ...model.efforts].join('|');
      await waitFor(async () => (await dialog.getByLabel('Effort').locator('option').allTextContents()).join('|') === wantedEfforts, { timeoutMs: 10_000, intervalMs: 200 });
      const efforts = await dialog.getByLabel('Effort').locator('option').allTextContents();
      const providers = await dialog.getByLabel('Provider').locator('option').allTextContents();
      await dialog.getByLabel('Effort').selectOption(effort);
      await dialog.getByLabel('Provider').selectOption(provider.name);
      await page.screenshot({ path: join(shotsRun, 'override.png') });
      const post = await postOf(page, `/api/tasks/${taskId}/override`, () => dialog.getByRole('button', { name: 'Override', exact: true }).click());
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
      const decision = queryOne(storeFile(home), "SELECT id, override_json, override_mode, jev_model FROM decisions WHERE task_id = ? AND step_id = ? AND kind = 'placement' ORDER BY created_at DESC LIMIT 1", taskId, answerRun.step_id);
      const recorded = decision?.override_json ? JSON.parse(decision.override_json) : undefined;
      const after = runs(home, taskId).length;
      await page.locator('.override-note').filter({ hasText: '(keep)' }).first().waitFor({ timeout: 15_000 });
      const ok =
        menuMatches &&
        menuIds.every((m) => suggested.includes(m)) &&
        post.status === 200 &&
        JSON.stringify(post.body) === JSON.stringify({ model: model.id, mode: 'keep', effort, provider: provider.name }) &&
        decision?.override_mode === 'keep' &&
        recorded?.source === 'owner' &&
        recorded.model === model.id &&
        recorded.effort === effort &&
        recorded.provider === provider.name &&
        after === before;
      return {
        ok,
        detail: `menu ${menu.providers.map((p) => `${p.name}: ${p.models.map((m) => m.id).join(', ')}`).join('; ')} (matches providers.json: ${menuMatches}); efforts offered ${efforts.join(', ')}; providers offered ${providers.join(', ')}; POST ${JSON.stringify(post.body)} -> ${post.status}; decision ${decision?.id} override_mode ${decision?.override_mode} ${decision?.override_json}; runs ${before} -> ${after}`,
      };
    });

    await check('Resume from the action bar starts a turn on the same native session', async () => {
      const resume = toolbar.getByRole('button', { name: 'Resume' });
      const enabled = await waitFor(() => resume.isEnabled(), { timeoutMs: 15_000, intervalMs: 250 });
      if (!enabled) {
        const t = taskRow(home, taskId);
        return { ok: false, detail: `Resume is disabled with the task ${t?.state} and its latest run ${runs(home, taskId).at(-1)?.state}` };
      }
      const post = await postOf(page, `/api/tasks/${taskId}/resume`, () => resume.click());
      const resumeRun = runs(home, taskId).find((r) => r.request_id === `resume:${answerRun.id}`);
      const ok = post.status === 200 && post.answer?.how === 'native' && !!resumeRun && resumeRun.native_session_id === asked.run.native_session_id;
      return { ok, detail: `POST -> ${post.status} ${JSON.stringify({ how: post.answer?.how, session: post.answer?.session })}; run ${resumeRun?.id ?? 'none'} (${resumeRun?.request_id ?? ''}) ${resumeRun?.state ?? ''} native ${resumeRun?.native_session_id ?? '-'}` };
    });

    await check('the step finishes with notes/colour.txt on the branch saying Blue', async () => {
      const end = await waitForTask(home, taskId, ['waiting-owner', ...ENDED], { timeoutMs });
      const t = taskRow(home, taskId);
      const colour = git(SANDBOX_CLONE, ['show', `refs/heads/${t.branch}:${COLOUR}`]);
      const report = queryOne(storeFile(home), "SELECT r.status, r.summary, s.id FROM reports r JOIN sessions s ON s.id = r.session_id WHERE r.task_id = ? ORDER BY r.created_at DESC LIMIT 1", taskId);
      const all = runs(home, taskId);
      const sameNative = all.every((r) => r.native_session_id === asked.run.native_session_id);
      const ok = end?.state === 'done' && colour.trim() === 'Blue' && report?.status === 'done' && /blue/i.test(report.summary);
      return { ok, detail: `${taskId} ${end?.state}: ${t?.state_reason}; ${COLOUR} on ${t?.branch}: ${JSON.stringify(colour)}; last report ${report?.id} ${report?.status}: ${(report?.summary ?? '').slice(0, 160)}; runs ${all.map((r) => `${r.id} ${r.state}`).join(', ')} (one native session: ${sameNative})` };
    });

    await check('no secret in the store, its WAL, the logs or the evidence of the temporary home', () => {
      const file = storeFile(home);
      const evidence = query(file, 'SELECT worktree_path FROM tasks WHERE worktree_path IS NOT NULL').map((r) => join(r.worktree_path, '.jv-evidence'));
      const r = leakCheck([file, `${file}-wal`, join(home, 'logs'), ...evidence], { secretsDir: join(home, 'secrets') });
      return { ok: r.secrets > 0 && r.leaks.length === 0 && r.errors.length === 0, detail: `${r.secrets} key files against ${r.checked.length} paths${r.leaks.length ? `; found in ${r.leaks.map((l) => l.file).join(', ')}` : ''}` };
    });
  };
  try {
    await journey();
  } finally {
    if (home && taskId) {
      const t = taskRow(home, taskId);
      if (t && !ENDED.includes(t.state)) {
        const r = jvJson(['task', 'stop', taskId, '--discard'], { home, timeoutMs: 60_000 });
        note(`${taskId} was ${t.state} at the end; jv task stop --discard exit ${r.code}`);
      }
    }
    if (browser) await browser.close();
    if (ui) await stopChild(ui.child);
    mkdirSync(SHOTS_DIR, { recursive: true });
    for (const [from, to] of [['needs-decision.png', 'm06-needs-decision-1280x800.png'], ['changes-committed.png', 'm06-changes-1280x800.png']]) {
      try {
        copyFileSync(join(shotsRun, from), join(SHOTS_DIR, to));
      } catch {
        note(`no screenshot ${from}`);
      }
    }
    if (home) {
      note(`worktrees removed from the clone: ${removeWorktreesUnder(SANDBOX_CLONE, home).length}`);
      await check('the sandbox clone is on main with a clean status', () => {
        const branch = git(SANDBOX_CLONE, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const status = git(SANDBOX_CLONE, ['status', '--porcelain']);
        return { ok: branch === 'main' && status === '', detail: `${branch}; status ${status === '' ? 'clean' : JSON.stringify(status)}` };
      });
    }
    if (flags.keep) note(`kept ${runDir(id)}`);
    else cleanup(id);
  }
  return finish(JOURNEY, { startedAt: started, mode: MODE });
}

runJourney(JOURNEY, main);
