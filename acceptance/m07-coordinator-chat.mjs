// M7 Coordinator chat (brief section 14), on the sandbox with the real providers in a temporary JV_HOME:
// `jv coordinator start` on the sandbox; the UI project page shows the coordinator's first status reply; a message
// typed in the composer ("status") reaches the tmux window and the coordinator's reply appears in the page within 10
// seconds; the response time is shown at the end of the turn.
//
// - A coordinator says nothing before its first message (docs/findings.md, "The coordinator conversation with a real
//   coordinator"), so its first status reply is its answer to `jv coordinator message --project jv-mono-sandbox
//   "status"`; the composer's "status" is the second turn.
// - The tmux session jv-coord-<project> has one name for every JV_HOME on this machine: the journey does not run
//   (blocked) when that session exists before it starts, and at the end it stops only the session it started:
//   `jv coordinator stop`, then kill-session only when the pane still runs this run's `jv exec --session <R>` and the
//   claude reading this run's prompt file.
// - The coordinator's Claude runs with HOME the provider home of the temporary JV_HOME (jv exec's environment, D-007):
//   the transcript the tail reads lies under <home>/homes/claude-main/.claude/projects/, no transcript of that session
//   is under ~/.claude/projects/, and the owner's ~/.claude.json has the same sha1 before the start and after the
//   stop (as M9 checks for its session).
// - "Within 10 seconds" runs from the composer's Enter to the turn's reply visible in the page: a MutationObserver in
//   the page stamps every new reply, and nothing calls the transcript API during the timed turn (that route tails,
//   which would speed the page up). The reply is the coordinator text that ends the turn (the one carrying the
//   response time); the first text of the turn is reported too. The limit is the brief's and is never widened.
// - The response time at the end of the turn is the chat's ResponseTime (response-time.tsx): it must be visible on
//   that reply, say what the store's responseMs says, and be plausible against the time measured in the page.
// - The main sandbox: a coordinator asked only for status changes nothing; a task it starts anyway is stopped, and
//   the sandbox is checked on main with a clean status at the end.
//
// Usage: node acceptance/m07-coordinator-chat.mjs [--keep]
// Exit 0 when every check passes, 1 otherwise, 2 when blocked. Writes acceptance/results/m07.json and the screenshots
// acceptance/shots/m07-project-chat-1280x800-{light,dark}.png.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import {
  check,
  cleanup,
  finish,
  git,
  HOME,
  jvJson,
  leakCheck,
  log,
  note,
  parseFlags,
  queryOne,
  realJvHome,
  REAL_JV_HOME,
  removeWorktreesUnder,
  run,
  runId,
  runJourney,
  SANDBOX,
  SANDBOX_NAME,
  SHOTS_DIR,
  sleep,
  startUi,
  stopChild,
  storeFile,
  uiPage,
  waitFor,
} from './lib.mjs';

const JOURNEY = 'm07';
const USAGE = 'node acceptance/m07-coordinator-chat.mjs [--keep]';
const PROJECT = SANDBOX_NAME;
/** core coordinatorTmuxName(): jv-coord-<project> with "." and ":" made "_". */
const TMUX_NAME = `jv-coord-${PROJECT.replace(/[.:]/g, '_')}`;
const CLAUDE = join(HOME, '.local', 'bin', 'claude');
const CLAUDE_JSON = join(HOME, '.claude.json');
const MESSAGE = 'status';
/** The brief's limit for the composer's turn. */
const REPLY_LIMIT_MS = 10_000;
/** How long a turn may take before the journey stops waiting for it (not the brief's limit). */
const TURN_TIMEOUT_MS = 180_000;
/** A turn is over when the page shows no new reply for this long and the pane is not working. */
const SETTLE_MS = 6_000;
/** The delivery path between the store's times and the page (POST, typing, the 1 s tail, the change event, refetch). */
const PAGE_OVERHEAD_MAX_MS = 5_000;
/** The owner's line as the coordinator's pane shows it: "❯  [owner]  status" (docs/findings.md). */
const PANE_OWNER_LINE = /\[owner\]\s+status\s*$/gm;

// ---- tmux and processes -------------------------------------------------------------------------------------------

function tmux(args) {
  return run('tmux', args, { timeoutMs: 15_000 });
}

function tmuxHas(name) {
  return tmux(['has-session', '-t', `=${name}`]).code === 0;
}

/** The visible screen of the pane, or with `history` the last 500 lines of its scrollback too. */
function capture(name, { history = false } = {}) {
  const r = tmux(['capture-pane', '-p', '-J', ...(history ? ['-S', '-500'] : []), '-t', `=${name}:`]);
  return r.code === 0 ? r.stdout : '';
}

function ownerLinesInPane(name) {
  return (capture(name, { history: true }).match(PANE_OWNER_LINE) ?? []).length;
}

/** Claude Code shows "esc to interrupt" while it works on a turn. */
function paneBusy(name) {
  return /esc to interrupt/i.test(capture(name));
}

function panePid(name) {
  const r = tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_pid}']);
  const pid = Number(r.stdout.trim());
  return r.code === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function commandLine(pid) {
  const r = run('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : '';
}

function childPids(pid) {
  return run('pgrep', ['-P', String(pid)], { timeoutMs: 10_000 })
    .stdout.split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * The command lines of the pane's process and its children (jv exec and the claude it runs). jv exec carries the
 * secrets in its child's environment only (D-007), never on a command line, so these hold none.
 */
function paneProcesses(name) {
  const pid = panePid(name);
  if (pid === undefined) return [];
  return [pid, ...childPids(pid)].map((p) => ({ pid: p, command: commandLine(p) })).filter((p) => p.command !== '');
}

/** Whether the pane runs this run's coordinator: jv exec of its session row, or a process naming the temporary home. */
function paneIsThisRuns(name, { sessionId, home }) {
  const procs = paneProcesses(name);
  return procs.some((p) => (sessionId && p.command.includes(`exec --session ${sessionId}`)) || (home && p.command.includes(home)));
}

// ---- the owner's ~/.claude.json, by hash only ---------------------------------------------------------------------

function sha1(file) {
  return existsSync(file) ? createHash('sha1').update(readFileSync(file)).digest('hex') : 'missing';
}

/**
 * What a Claude Code process with HOME the owner's home would leave in ~/.claude.json, without keeping any content:
 * the sha1 of each top-level value (to name what changed), numStartups (every start counts one), and the sha1 of the
 * sandbox's `projects` entry (a session in that folder updates it).
 */
function claudeJsonMarks(file) {
  const hash = (v) => createHash('sha1').update(JSON.stringify(v ?? null)).digest('hex');
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    return {
      ok: true,
      keys: Object.fromEntries(Object.entries(json).map(([k, v]) => [k, hash(v)])),
      startups: typeof json.numStartups === 'number' ? json.numStartups : null,
      sandbox: hash(json.projects?.[SANDBOX]),
    };
  } catch {
    return { ok: false, keys: {}, startups: null, sandbox: '' };
  }
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).sort();
}

// ---- the page -----------------------------------------------------------------------------------------------------

/** Installs the reply stamper: window.__m07 is [{t, n}] each time the count of coordinator replies changes. */
async function installStamper(page) {
  await page.evaluate(() => {
    const w = globalThis;
    w.__m07 = [];
    let last = -1;
    const stamp = () => {
      const n = w.document.querySelectorAll('.pw-reply').length;
      if (n !== last) {
        last = n;
        w.__m07.push({ t: Date.now(), n });
      }
    };
    stamp();
    new w.MutationObserver(stamp).observe(w.document.body, { childList: true, subtree: true });
  });
}

/** When the page first showed at least `count` replies (epoch ms), or undefined. */
async function shownAt(page, count) {
  const stamps = await page.evaluate(() => globalThis.__m07 ?? []);
  return stamps.find((s) => s.n >= count)?.t;
}

const replyCount = (page) => page.locator('.pw-reply').count();
const ownerCount = (page) => page.locator('.pw-owner').count();

/**
 * Waits until the turn is over: the page shows more than `repliesBefore` replies, no new reply for SETTLE_MS, and the
 * pane is not working. Reads only the page and the pane (never the transcript API, which tails). Returns the reply
 * count then, or undefined after TURN_TIMEOUT_MS.
 */
async function waitForSettledTurn(page, repliesBefore) {
  let last = -1;
  let since = Date.now();
  return waitFor(
    async () => {
      const n = await replyCount(page);
      if (n !== last) {
        last = n;
        since = Date.now();
      }
      return n > repliesBefore && Date.now() - since >= SETTLE_MS && !paneBusy(TMUX_NAME) ? n : undefined;
    },
    { timeoutMs: TURN_TIMEOUT_MS, intervalMs: 250 },
  );
}

async function transcriptOf(page, url) {
  const r = await page.request.get(`${url}/api/projects/${encodeURIComponent(PROJECT)}/coordinator/transcript?limit=200`);
  if (!r.ok()) throw new Error(`transcript: HTTP ${r.status()}`);
  return r.json();
}

/**
 * The turn of one owner line in a transcript: the owner entry (by its messages row id), the coordinator texts that
 * answer it (up to the next owner or jv line), the last of them (the reply that ends the turn), and the index of each
 * among all coordinator texts, which is its index among the page's .pw-reply elements.
 */
function turnOf(transcript, messageId) {
  const entries = transcript.entries ?? [];
  const at = entries.findIndex((e) => e.role === 'owner' && e.messageId === messageId);
  if (at < 0) return undefined;
  const coordinatorIndex = new Map();
  entries.filter((e) => e.role === 'coordinator').forEach((e, i) => coordinatorIndex.set(e.seq, i));
  const replies = [];
  for (const e of entries.slice(at + 1)) {
    if (e.role === 'owner' || e.role === 'jv') break;
    if (e.role === 'coordinator') replies.push({ ...e, index: coordinatorIndex.get(e.seq) });
  }
  const tools = entries.slice(at + 1).filter((e) => e.role === 'tool').length;
  const turn = (transcript.turns ?? []).find((t) => t.promptAt === entries[at].at);
  return { owner: entries[at], replies, first: replies[0], final: replies.at(-1), turn, tools };
}

/** A few words of a reply's Markdown that the page must show (as M4 looks for a report). */
function wordsOf(text) {
  return String(text ?? '')
    .replace(/[`*_#>[\]()|]/g, ' ')
    .split(/\s+/)
    .filter((w) => /^[A-Za-z][A-Za-z-]{4,}$/.test(w))
    .slice(0, 5);
}

/** The text of the page's reply number `index` and its response time, if any. */
async function replyInPage(page, index) {
  const reply = page.locator('.pw-reply').nth(index);
  const text = (await reply.innerText()).replace(/\s+/g, ' ');
  const stamp = reply.locator('.response-time');
  const hasStamp = (await stamp.count()) > 0;
  return {
    text,
    stampVisible: hasStamp && (await stamp.isVisible()),
    clock: hasStamp ? ((await stamp.locator('time').textContent()) ?? '').trim() : '',
    took: hasStamp && (await stamp.locator('.response-took').count()) > 0 ? ((await stamp.locator('.response-took').textContent()) ?? '').replace(/^[\s·]+/, '').trim() : '',
  };
}

/** web/src/time.ts msText and duration: what the chat prints for a response time. */
function msText(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

function localClock(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const secs = (ms) => (ms === undefined || ms === null ? '?' : `${(ms / 1000).toFixed(1)} s`);

// ---- the journey --------------------------------------------------------------------------------------------------

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { usage: USAGE });
  const started = Date.now();
  const id = runId(JOURNEY);
  log(`M7 Coordinator chat ${id}`);

  // Before anything is created: the tmux name is shared by every JV_HOME on this machine.
  if (tmuxHas(TMUX_NAME)) {
    note(`tmux session ${TMUX_NAME} exists before the run (another home's coordinator, or a run still going); it is left alone`);
    return finish(JOURNEY, { startedAt: started, blocked: `tmux session ${TMUX_NAME} already exists` });
  }
  if (!existsSync(CLAUDE)) return finish(JOURNEY, { startedAt: started, blocked: `no Claude Code at ${CLAUDE}` });
  if (!existsSync(join(REAL_JV_HOME, 'providers.json'))) return finish(JOURNEY, { startedAt: started, blocked: 'no ~/.jv/providers.json to seed the temporary home from' });

  const sandboxBefore = { branch: git(SANDBOX, ['branch', '--show-current']), status: git(SANDBOX, ['status', '--porcelain']) };
  note(`sandbox before: branch ${sandboxBefore.branch}, ${sandboxBefore.status === '' ? 'clean' : 'not clean'}`);

  let home;
  let ui;
  let browser;
  let page;
  let sessionId;
  let nativeId;
  let weStarted = false;
  let claudeJsonBefore;
  let marksBefore;
  let stopped;
  try {
    home = realJvHome(id).home;
    note(`temporary home ${home}`);
    ui = await startUi(home);
    ({ browser, page } = await uiPage(ui));
    await page.goto(`${ui.url}/p/${encodeURIComponent(PROJECT)}`);
    await page.getByRole('heading', { name: PROJECT, level: 1 }).waitFor({ timeout: 20_000 });
    await installStamper(page);

    claudeJsonBefore = sha1(CLAUDE_JSON);
    marksBefore = claudeJsonMarks(CLAUDE_JSON);
    await check('jv coordinator start on the sandbox: running in tmux jv-coord-jv-mono-sandbox, screen ready', async () => {
      const r = jvJson(['coordinator', 'start', '--project', PROJECT], { home, timeoutMs: 150_000 });
      weStarted = tmuxHas(TMUX_NAME);
      if (r.code !== 0 || !r.json) return { ok: false, detail: `exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}` };
      sessionId = r.json.sessionId;
      nativeId = r.json.nativeSessionId;
      let screen = r.json.screen;
      if (screen !== 'ready') {
        const ready = await waitFor(() => {
          const s = jvJson(['coordinator', 'status', '--project', PROJECT], { home });
          screen = s.json?.screen ?? screen;
          return screen === 'ready' || screen === 'dialog' || screen === 'gone' ? screen : undefined;
        }, { timeoutMs: 60_000, intervalMs: 1000 });
        screen = ready ?? screen;
      }
      const rc = r.json.remoteControl;
      const ok = r.json.started === true && r.json.running === true && r.json.tmuxSession === TMUX_NAME && screen === 'ready' && r.json.provider === 'claude-main';
      return { ok, detail: `session ${sessionId} (Claude session ${nativeId}), ${r.json.provider} ${r.json.model} ${r.json.effort}, screen ${screen}, Remote Control ${rc?.requested ? 'requested' : rc?.state ?? 'not reported'}` };
    });
    if (!sessionId) throw new Error('the coordinator did not start');

    await check('the pane runs this run\'s jv exec and claude, on the temporary home\'s prompt', () => {
      const procs = paneProcesses(TMUX_NAME);
      const exec = procs.find((p) => p.command.includes(`exec --session ${sessionId}`));
      // jv exec's own command line names claude's arguments too; claude is its child.
      const claude = procs.find((p) => p.pid !== procs[0]?.pid && p.command.includes('--append-system-prompt-file') && p.command.includes(join(home, 'projects', PROJECT, 'coordinator-prompt.md')));
      return { ok: !!exec && !!claude, detail: `pane pid ${procs[0]?.pid ?? 'none'}: jv exec ${exec ? `pid ${exec.pid}` : 'not found'}, claude ${claude ? `pid ${claude.pid}` : 'not found'}` };
    });

    await check('the project page shows the running coordinator and the composer', async () => {
      await page.getByText('coordinator running', { exact: true }).waitFor({ timeout: 20_000 });
      await page.getByLabel('Message the coordinator').waitFor({ timeout: 20_000 });
      return { ok: true, detail: 'chip "coordinator running", composer "Message the coordinator"' };
    });

    // ---- turn 1: the first status reply ------------------------------------------------------------------------
    let first;
    await check('the page shows the coordinator\'s first status reply (to jv coordinator message "status")', async () => {
      const repliesBefore = await replyCount(page);
      const sent = jvJson(['coordinator', 'message', '--project', PROJECT, MESSAGE], { home, timeoutMs: 60_000 });
      if (sent.code !== 0 || !sent.json?.messageId) return { ok: false, detail: `jv coordinator message: exit ${sent.code}: ${(sent.stderr || sent.stdout).trim().slice(0, 300)}` };
      const settled = await waitForSettledTurn(page, repliesBefore);
      if (settled === undefined) return { ok: false, detail: `no settled reply within ${TURN_TIMEOUT_MS / 1000} s (page shows ${await replyCount(page)} replies)` };
      first = turnOf(await transcriptOf(page, ui.url), sent.json.messageId);
      if (!first?.final) return { ok: false, detail: `the transcript has no reply to ${sent.json.messageId}` };
      const shown = await replyInPage(page, first.final.index);
      const words = wordsOf(first.final.text);
      const missing = words.filter((w) => !shown.text.includes(w));
      const owner = await page.locator('.pw-owner').filter({ hasText: MESSAGE }).count();
      return {
        ok: words.length >= 2 && missing.length === 0 && owner >= 1,
        detail: `${first.replies.length} text(s), ${first.tools} tool call(s), responseMs ${first.turn?.responseMs ?? 'none'}; page shows "${shown.text.slice(0, 140)}"${missing.length ? `; missing ${missing.join(', ')}` : ''}`,
      };
    });

    await check('the coordinator\'s Claude runs with HOME the temporary provider home (its transcript is there, not under ~/.claude)', () => {
      const row = queryOne(storeFile(home), 'SELECT value FROM meta WHERE key = ?', `coordinator_tail:${sessionId}`);
      const file = row ? JSON.parse(row.value).file : undefined;
      const providerProjects = join(home, 'homes', 'claude-main', '.claude', 'projects') + sep;
      const ownerCopy = file ? join(HOME, '.claude', 'projects', basename(dirname(file)), `${nativeId}.jsonl`) : undefined;
      const ok = !!file && file.startsWith(providerProjects) && basename(file) === `${nativeId}.jsonl` && existsSync(file) && !existsSync(ownerCopy);
      return { ok, detail: `transcript ${file ? file.replace(home, '<home>') : 'not recorded'}; ~/.claude/projects copy ${ownerCopy && existsSync(ownerCopy) ? 'EXISTS' : 'none'}` };
    });

    // ---- turn 2: the composer ----------------------------------------------------------------------------------
    let second;
    let measured;
    let firstTextMs;
    const ownerPaneBefore = ownerLinesInPane(TMUX_NAME);
    const repliesBefore = await replyCount(page);
    const ownersBefore = await ownerCount(page);
    const box = page.getByLabel('Message the coordinator');
    await box.click();
    await box.pressSequentially(MESSAGE, { delay: 40 });
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/projects/${encodeURIComponent(PROJECT)}/coordinator/message`), { timeout: 30_000 });
    const t0 = Date.now();
    await box.press('Enter');
    const response = await posted.catch((error) => ({ failed: String(error?.message ?? error) }));
    const sent = response.failed ? { error: response.failed } : { status: response.status(), json: await response.json().catch(() => ({})) };

    await check('the composer\'s "status" reaches the tmux window (capture-pane shows the owner line)', async () => {
      if (sent.error || sent.status !== 200) return { ok: false, detail: `POST .../coordinator/message: ${sent.error ?? `HTTP ${sent.status} ${JSON.stringify(sent.json).slice(0, 200)}`}` };
      const after = await waitFor(() => {
        const n = ownerLinesInPane(TMUX_NAME);
        return n > ownerPaneBefore ? n : undefined;
      }, { timeoutMs: 5000, intervalMs: 200 });
      const owners = await page.locator('.pw-owner').count();
      return { ok: after !== undefined && after === ownerPaneBefore + 1, detail: `pane shows "[owner]  ${MESSAGE}" ${after ?? ownerPaneBefore} time(s) (was ${ownerPaneBefore}); message ${sent.json.messageId} typed ${secs(Date.parse(sent.json.typedAt) - t0)} after Enter (${sent.json.how}); page owner lines ${ownersBefore} -> ${owners}` };
    });

    await check(`the coordinator's reply appears in the page within ${REPLY_LIMIT_MS / 1000} s of the composer's Enter`, async () => {
      if (!sent.json?.messageId) return { ok: false, detail: 'no message was sent' };
      const settled = await waitForSettledTurn(page, repliesBefore);
      if (settled === undefined) return { ok: false, detail: `no settled reply within ${TURN_TIMEOUT_MS / 1000} s` };
      second = turnOf(await transcriptOf(page, ui.url), sent.json.messageId);
      if (!second?.final) return { ok: false, detail: `the transcript has no reply to ${sent.json.messageId}` };
      const tFinal = await shownAt(page, second.final.index + 1);
      const tFirst = await shownAt(page, second.first.index + 1);
      measured = tFinal === undefined ? undefined : tFinal - t0;
      firstTextMs = tFirst === undefined ? undefined : tFirst - t0;
      const responseMs = second.turn?.responseMs;
      const words = wordsOf(second.final.text);
      const shown = await replyInPage(page, second.final.index);
      const missing = words.filter((w) => !shown.text.includes(w));
      const ok = measured !== undefined && measured <= REPLY_LIMIT_MS && missing.length === 0;
      return {
        ok,
        detail: `reply visible ${secs(measured)} after Enter (first text ${secs(firstTextMs)}; ${second.replies.length} text(s), ${second.tools} tool call(s)); coordinator responseMs ${responseMs ?? 'none'}; page overhead ${measured !== undefined && responseMs !== null && responseMs !== undefined ? secs(measured - responseMs) : '?'}; "${shown.text.slice(0, 140)}"${missing.length ? `; missing ${missing.join(', ')}` : ''}`,
      };
    });

    await check('the response time is shown at the end of the turn and matches the store and the measured time', async () => {
      if (!second?.final) return { ok: false, detail: 'no reply to look at' };
      const shown = await replyInPage(page, second.final.index);
      const responseMs = second.turn?.responseMs;
      const want = msText(responseMs);
      const otherStamps = await Promise.all(second.replies.slice(0, -1).map(async (r) => (await replyInPage(page, r.index)).stampVisible));
      const overhead = measured !== undefined && typeof responseMs === 'number' ? measured - responseMs : undefined;
      const plausible = overhead !== undefined && overhead >= -500 && overhead <= PAGE_OVERHEAD_MAX_MS;
      const ok = shown.stampVisible && shown.took !== '' && shown.took === want && shown.clock === localClock(second.final.at) && !otherStamps.includes(true) && plausible;
      return { ok, detail: `shows "${shown.clock} · ${shown.took}" (store responseMs ${responseMs ?? 'none'} = "${want}", reply at ${localClock(second.final.at)}); measured in the page ${secs(measured)}, overhead ${secs(overhead)}${otherStamps.includes(true) ? '; a stamp on an earlier text of the turn' : ''}` };
    });

    // Screenshots of the conversation, light and dark, at 1280 by 800.
    mkdirSync(SHOTS_DIR, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await sleep(400);
      await page.screenshot({ path: join(SHOTS_DIR, `m07-project-chat-1280x800-${scheme}.png`) });
    }
    note(`screenshots acceptance/shots/m07-project-chat-1280x800-light.png and -dark.png`);
    if (first?.turn) note(`first turn: responseMs ${first.turn.responseMs}, ${first.replies.length} text(s), ${first.tools} tool call(s)`);
    if (second?.turn) note(`composer turn: reply visible ${secs(measured)} after Enter, first text ${secs(firstTextMs)}, coordinator responseMs ${second.turn.responseMs}`);

    const tasks = jvJson(['task', 'list', '--project', PROJECT], { home }).json?.tasks ?? [];
    note(`tasks on the sandbox after the turns: ${tasks.length}`);
    for (const t of tasks) {
      if (['done', 'failed', 'stopped'].includes(t.state)) continue;
      const s = jvJson(['task', 'stop', t.id], { home, timeoutMs: 60_000 });
      note(`the coordinator started ${t.id} (${t.state}); stopped: exit ${s.code}`);
    }

    await check('no secret of the home in the store, its WAL or the logs', () => {
      const file = storeFile(home);
      const r = leakCheck([file, `${file}-wal`, join(home, 'logs')], { secretsDir: join(home, 'secrets') });
      return { ok: r.secrets > 0 && r.leaks.length === 0 && r.errors.length === 0, detail: `${r.secrets} key files against ${r.checked.length} paths${r.leaks.length ? `; found in ${r.leaks.map((l) => l.file).join(', ')}` : ''}` };
    });
  } catch (error) {
    await check('the journey ran to its end', () => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (home && weStarted) {
      stopped = jvJson(['coordinator', 'stop', '--project', PROJECT], { home, timeoutMs: 60_000 });
      note(`jv coordinator stop: exit ${stopped.code}, ${stopped.json?.reason ?? (stopped.stderr || stopped.stdout).trim().slice(0, 200)}`);
      if (tmuxHas(TMUX_NAME)) {
        if (paneIsThisRuns(TMUX_NAME, { sessionId, home })) {
          tmux(['kill-session', '-t', `=${TMUX_NAME}`]);
          note(`tmux session ${TMUX_NAME} was still there after the stop; killed (its pane ran this run's coordinator)`);
        } else note(`tmux session ${TMUX_NAME} is there and is not this run's; left alone`);
      }
    }
    if (ui) await stopChild(ui.child);
    if (home) note(`worktrees removed from the sandbox: ${removeWorktreesUnder(SANDBOX, home).length}`);
  }

  await check('the coordinator\'s tmux session is gone after jv coordinator stop', () => ({
    ok: weStarted && stopped?.code === 0 && stopped.json?.stopped === true && !tmuxHas(TMUX_NAME),
    detail: `stop ${stopped ? `exit ${stopped.code}, ${stopped.json?.killed ? 'killed after /exit' : 'ended by /exit'}` : 'not run'}; tmux ${tmuxHas(TMUX_NAME) ? 'still there' : 'gone'}`,
  }));
  await check('the owner\'s ~/.claude.json has the same sha1 before the start and after the stop', () => {
    const after = sha1(CLAUDE_JSON);
    if (claudeJsonBefore === undefined) return { ok: false, detail: 'no sha1 taken before the start' };
    if (after === claudeJsonBefore) return { ok: true, detail: `sha1 ${after.slice(0, 12)} unchanged` };
    const keys = changedKeys(marksBefore?.keys ?? {}, claudeJsonMarks(CLAUDE_JSON).keys);
    note(`~/.claude.json changed during the run in ${keys.join(', ') || 'no top-level key'}; the next check says whether the coordinator could have written it`);
    return { ok: false, detail: `sha1 ${claudeJsonBefore.slice(0, 12)} -> ${after.slice(0, 12)}; changed keys: ${keys.join(', ') || 'none at the top level'}` };
  });
  await check('the coordinator left no mark in the owner\'s ~/.claude.json: no Claude Code start counted, the sandbox entry unchanged, its session id absent', () => {
    const after = claudeJsonMarks(CLAUDE_JSON);
    if (!marksBefore?.ok || !after.ok) return { ok: false, detail: `~/.claude.json not readable as JSON ${marksBefore?.ok ? 'after' : 'before'} the run` };
    const named = !!nativeId && readFileSync(CLAUDE_JSON, 'utf8').includes(nativeId);
    const ok = after.startups === marksBefore.startups && after.sandbox === marksBefore.sandbox && !named;
    return { ok, detail: `numStartups ${marksBefore.startups} -> ${after.startups}; projects["${SANDBOX.replace(HOME, '~')}"] ${after.sandbox === marksBefore.sandbox ? 'unchanged' : 'CHANGED'}; session id ${nativeId ?? '?'} ${named ? 'PRESENT' : 'absent'}` };
  });
  await check('the sandbox is left on main with a clean status and no worktree of this run', () => {
    const branch = git(SANDBOX, ['branch', '--show-current']);
    const status = git(SANDBOX, ['status', '--porcelain']);
    const worktrees = home ? git(SANDBOX, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ') && l.includes(home)).length : 0;
    return { ok: branch === 'main' && status === '' && worktrees === 0, detail: `branch ${branch}, ${status === '' ? 'clean' : `not clean: ${status.split('\n').length} path(s)`}, ${worktrees} worktree(s) of this run` };
  });

  if (!flags.keep) cleanup(id);
  else if (home) note(`kept ${home}`);
  return finish(JOURNEY, { startedAt: started, mode: 'real coordinator (claude-main) in a temporary JV_HOME, UI on a free port' });
}

runJourney(JOURNEY, main);
