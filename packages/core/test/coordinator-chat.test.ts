// The coordinator conversation (coordinator-chat.ts) against a fake tmux and a transcript file the test writes: the
// tail's events, offsets, idempotence, incomplete lines and usage across reads; the owner's line (the prefix, the
// buffer for multi-line text, the messages row on the conversation task, the event) and its transcript entry not
// recorded twice; refusals; the transcript view with turn ends; closing ended sessions; and the typing lock that keeps
// owner lines and wake lines apart, across processes. No real tmux, no model; every value is made up.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { FakeTmux, TRUST_SCREEN, writeCoordinatorHome } from './fixtures/coordinator-fixture.js';
import { FAKE_TOKEN, makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-coordinator-chat-test-');
writeCoordinatorHome(home);
process.env.JV_HOME = home;
const c = await import('../src/coordinator.js');
const chat = await import('../src/coordinator-chat.js');
const { openStore } = await import('../src/store.js');
const { JvError } = await import('../src/errors.js');
const { claudeTranscriptPath } = await import('../src/transcript.js');

after(() => rmSync(home, { recursive: true, force: true }));

const store = openStore();
after(() => store.close());

const claudeMainHome = join(home, 'homes', 'claude-main');

function deps(tmux: FakeTmux) {
  return {
    tmux: tmux.run,
    jvCommand: '/opt/jv/bin/jv',
    claudePath: '/usr/bin/claude',
    sleep: async () => {},
    readyTimeoutMs: 50,
    stopWaitMs: 50,
    readCmdline: (pid: number) => tmux.cmdline(pid),
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
  };
}

/** A project with a running coordinator in a fake tmux, and the path its transcript will have. */
async function started(name: string) {
  const repo = join(home, 'repos', name);
  mkdirSync(repo, { recursive: true });
  const project = store.createProject({ name, path: repo, default_branch: 'main' }).row;
  const tmux = new FakeTmux();
  const r = await c.startCoordinator(store, name, deps(tmux));
  const session = store.getSession(r.sessionId!)!;
  const file = claudeTranscriptPath(claudeMainHome, repo, session.native_session_id!);
  mkdirSync(dirname(file), { recursive: true });
  const fake = tmux.sessions.get(c.coordinatorTmuxName(name))!;
  return { project, tmux, session, file, fake, msgDeps: { tmux: tmux.run, readCmdline: (pid: number) => tmux.cmdline(pid) } };
}

let clock = Date.now() - 10 * 60_000;
const at = (step = 1000) => new Date((clock += step)).toISOString();
const line = (v: object) => `${JSON.stringify(v)}\n`;
const userLine = (text: string, t = at()) => line({ type: 'user', message: { role: 'user', content: text }, timestamp: t });
type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
const textLine = (id: string, text: string, usage: Usage, t = at(), stop: string | null = 'end_turn') =>
  line({ type: 'assistant', message: { id, role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }], usage }, timestamp: t });
const toolLine = (id: string, toolId: string, name: string, input: unknown, usage: Usage, t = at()) =>
  line({ type: 'assistant', message: { id, role: 'assistant', stop_reason: null, content: [{ type: 'tool_use', id: toolId, name, input }], usage }, timestamp: t });
const resultLine = (toolId: string, content: string, t = at()) =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content }] }, timestamp: t });

function events(sessionId: string, afterSeq = 0) {
  return store.listEvents(sessionId, { afterSeq }).map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, payload: JSON.parse(e.payload) as Record<string, unknown> }));
}

test('tail: nothing before the transcript exists; then jv lines, text, tool calls and results, usage at the transcript times; idempotent; an incomplete line waits', async () => {
  const { project, session, file } = await started('tail-basics');
  const before = chat.tailCoordinator(store, { project: project.name });
  assert.deepEqual(before.projects, [{ project: 'tail-basics', session: session.id, events: 0, offset: 0 }]);

  const t1 = at();
  const t2 = at();
  const t3 = at();
  const t4 = at();
  const t5 = at();
  const complete =
    userLine('[jv] T1ABCDE (README) step implement: done. Run: jv report R1ABCDE', t1) +
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: meta' }, timestamp: t1 }) +
    line({ type: 'assistant', message: { id: 'a1', role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me look.' }], usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: t2 }) +
    toolLine('a1', 'tu1', 'Bash', { command: 'jv status --json\necho done', description: 'Status' }, { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 100 }, t2) +
    resultLine('tu1', '{"projects":[]}', t3) +
    line({ type: 'assistant', isSidechain: true, message: { id: 'side', content: [{ type: 'text', text: 'sidechain' }], usage: { input_tokens: 999 } }, timestamp: t3 }) +
    userLine('<command-name>/clear</command-name>', t3) +
    textLine('a2', 'T1ABCDE is done; nothing waits on you.', { input_tokens: 3, output_tokens: 9 }, t4);
  const partial = textLine('a3', 'One more thing.', { input_tokens: 1, output_tokens: 4 }, t5);
  writeFileSync(file, complete + partial.slice(0, 20));

  const first = chat.tailCoordinator(store, { project: project.name });
  const offset = Buffer.byteLength(complete);
  assert.deepEqual(first.projects, [{ project: 'tail-basics', session: session.id, events: 5, offset, file }]);
  const got = events(session.id);
  assert.deepEqual(got.map((e) => e.kind), ['message', 'tool-call', 'tool-result', 'text', 'usage']);
  assert.deepEqual(got[0]!.payload, { from: 'jv', role: 'user', text: '[jv] T1ABCDE (README) step implement: done. Run: jv report R1ABCDE', source: 'transcript' });
  assert.equal(got[0]!.at, t1);
  assert.equal(got[1]!.payload.name, 'Bash');
  assert.equal(got[1]!.at, t2);
  assert.deepEqual([got[2]!.payload.id, got[2]!.payload.ok, got[2]!.payload.output, got[2]!.payload.name], ['tu1', true, '{"projects":[]}', 'Bash']);
  assert.equal(got[3]!.payload.text, 'T1ABCDE is done; nothing waits on you.');
  assert.equal(got[3]!.at, t4);
  assert.ok(!got.some((e) => e.kind === 'thinking'), 'no thinking');
  assert.ok(!JSON.stringify(got).includes('sidechain'), 'no sidechain records');
  assert.ok(!JSON.stringify(got).includes('/clear'), 'no slash-command markup');
  // a1 counted once (its two records carry the same usage, the larger output wins), a2 once.
  assert.deepEqual(got[4]!.payload, { inputTokens: 13, outputTokens: 15, cacheReadTokens: 100, cacheWriteTokens: 0, apiCalls: 2, source: 'transcript' });
  assert.equal(store.getSession(session.id)!.input_tokens, 13);
  const meta = chat.readTailState(store, session.id);
  assert.equal(meta.offset, offset);
  assert.equal(meta.file, file);

  const again = chat.tailCoordinator(store, { project: project.name });
  assert.equal(again.projects[0]!.events, 0, 'nothing twice');
  assert.equal(events(session.id).length, 5);

  appendFileSync(file, partial.slice(20));
  const third = chat.tailCoordinator(store, { project: project.name });
  assert.equal(third.projects[0]!.events, 2, 'the completed line and its usage');
  assert.equal(third.projects[0]!.offset, statSync(file).size);
  const last = events(session.id, 5);
  assert.deepEqual(last.map((e) => [e.kind, e.payload.text ?? e.payload.outputTokens]), [['text', 'One more thing.'], ['usage', 4]]);
  assert.equal(chat.tailCoordinator(store, { project: project.name }).projects[0]!.events, 0);
});

test('tail: a message split across two reads counts its usage once; its larger output count wins', async () => {
  const { project, session, file } = await started('tail-usage');
  writeFileSync(file, toolLine('m1', 't1', 'Read', { file_path: 'README.md' }, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 7 }));
  chat.tailCoordinator(store, { project: project.name });
  appendFileSync(
    file,
    textLine('m1', 'Reading.', { input_tokens: 10, output_tokens: 8, cache_creation_input_tokens: 7 }, at(), null) +
      textLine('m2', 'Done.', { input_tokens: 2, output_tokens: 3 }),
  );
  chat.tailCoordinator(store, { project: project.name });
  const usage = events(session.id).filter((e) => e.kind === 'usage').map((e) => e.payload);
  assert.deepEqual(usage, [
    { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 7, apiCalls: 1, source: 'transcript' },
    { inputTokens: 2, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1, source: 'transcript' },
  ]);
  const row = store.getSession(session.id)!;
  assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_write_tokens], [12, 11, 7]);
});

test('message: types " [owner]  <text>", records the row on the conversation task and the event; its transcript entry is not recorded again', async () => {
  const { project, session, file, fake, msgDeps, tmux } = await started('msg-basics');
  // The coordinator said something the tail has not read yet: it is recorded before the owner's line.
  writeFileSync(file, textLine('b0', 'Ready.', { input_tokens: 1, output_tokens: 1 }));
  const r = await chat.messageCoordinator(store, 'msg-basics', '  status  ', msgDeps);
  assert.equal(r.how, 'typed');
  assert.equal(r.text, 'status');
  assert.equal(r.session, session.id);
  assert.equal(fake.submitted.at(-1), ' [owner]  status', 'the exact prefix: a space, the tag, two spaces');
  const sendKeys = tmux.calls.filter((a) => a[0] === 'send-keys');
  assert.deepEqual(sendKeys.at(-2), ['send-keys', '-t', '=jv-coord-msg-basics:', '-l', '--', ' [owner]  status']);
  assert.deepEqual(sendKeys.at(-1), ['send-keys', '-t', '=jv-coord-msg-basics:', 'Enter']);

  const conversation = store.coordinatorTask(project.id);
  const row = store.getMessage(r.messageId)!;
  assert.equal(row.task_id, conversation.id);
  assert.equal(row.session_id, session.id);
  assert.equal(row.direction, 'owner');
  assert.equal(row.text, 'status');
  assert.ok(row.delivered_at, 'delivered');
  assert.deepEqual(store.listMessages({ task_id: conversation.id }).map((m) => m.id), [r.messageId]);

  let got = events(session.id);
  assert.deepEqual(got.map((e) => e.kind), ['text', 'usage', 'message'], 'the earlier text first');
  const msg = got.at(-1)!;
  assert.deepEqual(msg.payload, { from: 'owner', role: 'user', text: 'status', messageId: r.messageId, source: 'message' });
  assert.equal(msg.at, r.typedAt);

  // Claude Code records the typed line (trimmed) and answers. The same text typed twice is matched twice.
  const r2 = await chat.messageCoordinator(store, 'msg-basics', 'status', msgDeps);
  const mark = store.lastEvent(session.id)!.seq;
  const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
  appendFileSync(
    file,
    userLine('[owner]  status', soon(100)) +
      textLine('b1', 'Nothing is running.', { input_tokens: 2, output_tokens: 3 }, soon(2000)) +
      userLine('[owner]  status', soon(3000)) +
      textLine('b2', 'Still nothing.', { input_tokens: 2, output_tokens: 3 }, soon(4000)),
  );
  chat.tailCoordinator(store, { project: project.name });
  got = events(session.id, mark);
  assert.deepEqual(got.map((e) => e.kind), ['text', 'text', 'usage'], 'no message event from the transcript for either typed line');
  assert.deepEqual(
    chat.readTailState(store, session.id).matched!.map((m) => m.id).sort(),
    [r.messageId, r2.messageId].sort(),
  );
});

test('message: multi-line text is pasted through a tmux buffer; control characters and known secrets never reach the pane or the store', async () => {
  const { session, fake, msgDeps, tmux } = await started('msg-paste');
  const r = await chat.messageCoordinator(store, 'msg-paste', 'first line\r\nsecond\u001b[201~ line\u0007', msgDeps);
  assert.equal(r.how, 'pasted');
  assert.equal(r.text, 'first line\nsecond[201~ line');
  assert.equal(fake.submitted.at(-1), ' [owner]  first line\nsecond[201~ line');
  const kinds = tmux.calls.slice(-3).map((a) => a[0]);
  assert.deepEqual(kinds, ['load-buffer', 'paste-buffer', 'send-keys'], 'buffer, bracketed paste, Enter');
  assert.ok(tmux.calls.at(-2)!.includes('-p'), 'bracketed paste');

  const secret = await chat.messageCoordinator(store, 'msg-paste', `use ${FAKE_TOKEN} please`, msgDeps);
  assert.equal(secret.text, 'use [redacted] please');
  assert.equal(fake.submitted.at(-1), ' [owner]  use [redacted] please');
  for (const call of tmux.calls) assert.ok(!call.join(' ').includes(FAKE_TOKEN), 'the secret never reaches tmux');
  assert.ok(!store.getMessage(secret.messageId)!.text.includes(FAKE_TOKEN));
  assert.ok(!JSON.stringify(events(session.id)).includes(FAKE_TOKEN));

  const tab = await chat.messageCoordinator(store, 'msg-paste', 'a\tb', msgDeps);
  assert.equal(tab.how, 'pasted', 'a tab typed with send-keys would autocomplete');
});

test('message: refused (exit 2) when the coordinator is not running, after stop, when the tmux session is foreign or not ours, and for empty or overlong text', async () => {
  const refusedWith = async (p: Promise<unknown>, re: RegExp) =>
    assert.rejects(p, (e: unknown) => e instanceof JvError && e.exitCode === 2 && re.test(e.message));

  const repo = join(home, 'repos', 'msg-none');
  mkdirSync(repo, { recursive: true });
  store.createProject({ name: 'msg-none', path: repo, default_branch: 'main' });
  const none = new FakeTmux();
  await refusedWith(chat.messageCoordinator(store, 'msg-none', 'hello', { tmux: none.run }), /not running; start it with jv coordinator start --project msg-none/);
  assert.equal(none.calls.length, 0, 'tmux is not even asked without a registered coordinator');

  const s = await started('msg-stopped');
  await c.stopCoordinator(store, 'msg-stopped', deps(s.tmux));
  await refusedWith(chat.messageCoordinator(store, 'msg-stopped', 'hello', s.msgDeps), /not running/);

  const g = await started('msg-gone');
  g.tmux.sessions.delete(c.coordinatorTmuxName('msg-gone'));
  await refusedWith(chat.messageCoordinator(store, 'msg-gone', 'hello', g.msgDeps), /not running/);
  // Our name, but the pane runs something else (a foreign session that took the name).
  g.tmux.addForeign(c.coordinatorTmuxName('msg-gone'));
  await refusedWith(chat.messageCoordinator(store, 'msg-gone', 'hello', g.msgDeps), /not running/);
  assert.deepEqual(g.tmux.sessions.get(c.coordinatorTmuxName('msg-gone'))!.submitted, [], 'nothing typed into it');

  const d = await started('msg-dialog');
  d.fake.screen = TRUST_SCREEN;
  await refusedWith(chat.messageCoordinator(store, 'msg-dialog', 'hello', d.msgDeps), /a dialog is waiting on the coordinator screen of msg-dialog/);
  assert.deepEqual(d.fake.submitted, [], 'Enter never reaches the dialog');

  const ok = await started('msg-text');
  await refusedWith(chat.messageCoordinator(store, 'msg-text', ' \n\u0007 ', ok.msgDeps), /empty/);
  await refusedWith(chat.messageCoordinator(store, 'msg-text', 'x'.repeat(chat.MESSAGE_TEXT_MAX + 1), ok.msgDeps), /longer than 20000/);
  assert.deepEqual(ok.fake.submitted, []);
  assert.equal(store.listMessages({ session_id: ok.session.id }).length, 0, 'no row for a refused line');
  await assert.rejects(chat.messageCoordinator(store, 'no-such-project', 'hi', ok.msgDeps), (e: unknown) => e instanceof JvError && e.exitCode === 3);
});

test('tail: a typed line with no row is left while its window is being typed into, then recorded from the transcript', async () => {
  const { project, session, file } = await started('tail-defer');
  const name = c.coordinatorTmuxName('tail-defer');
  const lockFile = c.typingLockFile(name);
  const head = textLine('c1', 'Hello.', { input_tokens: 1, output_tokens: 1 });
  const typed = userLine('[owner]  deploy nothing', new Date().toISOString());
  writeFileSync(file, head + typed + textLine('c2', 'Understood.', { input_tokens: 1, output_tokens: 1 }));

  // Another process (a made-up pid, alive by the test's word) holds the window's typing lock.
  mkdirSync(dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: 999_999, at: new Date().toISOString() }));
  const held = chat.tailCoordinator(store, { project: project.name, alive: () => true });
  assert.equal(held.projects[0]!.deferred, true);
  assert.equal(held.projects[0]!.offset, Buffer.byteLength(head), 'the offset stops at the typed line');
  assert.deepEqual(events(session.id).map((e) => e.kind), ['text', 'usage']);

  // The lock is free and still no row: the typist died after typing; the line is the owner's, from the transcript.
  rmSync(lockFile);
  const freed = chat.tailCoordinator(store, { project: project.name });
  assert.equal(freed.projects[0]!.deferred, undefined);
  const got = events(session.id);
  assert.deepEqual(got.map((e) => e.kind), ['text', 'usage', 'message', 'text', 'usage']);
  assert.deepEqual(got[2]!.payload, { from: 'owner', role: 'user', text: 'deploy nothing', source: 'transcript' });
  // Usage of c1 was counted before the deferral and is not counted again.
  assert.equal(store.getSession(session.id)!.input_tokens, 2);

  // Lines typed in the window itself (jv attach, Remote Control) are the owner's too; the handoff is jv's.
  appendFileSync(file, userLine('what is waiting?') + userLine(`${c.HANDOFF_PREFIX}\n\nTasks not done (0)`) + userLine('[Request interrupted by user]'));
  chat.tailCoordinator(store, { project: project.name });
  const tail = events(session.id, got.at(-1)!.seq);
  assert.deepEqual(
    tail.map((e) => [e.payload.from, e.payload.text]),
    [
      ['owner', 'what is waiting?'],
      ['jv', `${c.HANDOFF_PREFIX}\n\nTasks not done (0)`],
    ],
  );
});

test('transcript: entries in time order, tool results joined into their call, turn ends with response times, the open last turn, the limit', async () => {
  const { project, session, file, msgDeps } = await started('transcript-view');
  const empty = chat.coordinatorTranscript(store, project.name);
  assert.deepEqual([empty.session, empty.entries, empty.turns], [session.id, [], []]);

  const r = await chat.messageCoordinator(store, 'transcript-view', 'status', msgDeps);
  const t0 = Date.parse(r.typedAt);
  const iso = (ms: number) => new Date(t0 + ms).toISOString();
  writeFileSync(
    file,
    userLine('[owner]  status', iso(50)) +
      toolLine('d1', 'tu9', 'Bash', { command: 'jv status --json --project transcript-view' }, { input_tokens: 1, output_tokens: 1 }, iso(1000)) +
      resultLine('tu9', '{"tasks":[]}', iso(1500)) +
      textLine('d2', 'Nothing runs.', { input_tokens: 1, output_tokens: 1 }, iso(2500), null) +
      textLine('d3', 'Want a task?', { input_tokens: 1, output_tokens: 1 }, iso(3000)) +
      userLine('[jv] T2ABCDE (Docs) step document: done. Run: jv report R2ABCDE', iso(10_000)) +
      textLine('d4', 'Docs landed.', { input_tokens: 1, output_tokens: 1 }, iso(14_000)),
  );
  const view = chat.coordinatorTranscript(store, project.name, { refresh: true });
  assert.equal(view.session, session.id);
  assert.deepEqual(
    view.entries.map((e) => [e.role, e.text]),
    [
      ['owner', 'status'],
      ['tool', 'ran jv status --json --project transcript-view'],
      ['coordinator', 'Nothing runs.'],
      ['coordinator', 'Want a task?'],
      ['jv', '[jv] T2ABCDE (Docs) step document: done. Run: jv report R2ABCDE'],
      ['coordinator', 'Docs landed.'],
    ],
  );
  assert.equal(view.entries[0]!.messageId, r.messageId);
  assert.deepEqual(view.entries[1]!.tool, {
    id: 'tu9',
    name: 'Bash',
    input: JSON.stringify({ command: 'jv status --json --project transcript-view' }),
    output: '{"tasks":[]}',
    ok: true,
  });
  assert.deepEqual(
    view.turns,
    [
      { from: 'owner', promptAt: r.typedAt, endAt: iso(3000), responseMs: 3000, open: false },
      { from: 'jv', promptAt: iso(10_000), endAt: iso(14_000), responseMs: 4000, open: true },
    ],
  );
  assert.equal(view.entries[3]!.turnEnd, true);
  assert.equal(view.entries[3]!.responseMs, 3000);
  assert.equal(view.entries[2]!.turnEnd, undefined);

  const limited = chat.coordinatorTranscript(store, project.name, { limit: 2 });
  assert.deepEqual(limited.entries.map((e) => e.text), ['[jv] T2ABCDE (Docs) step document: done. Run: jv report R2ABCDE', 'Docs landed.']);
  assert.deepEqual(limited.turns.map((t) => t.from), ['jv']);
  assert.throws(() => chat.coordinatorTranscript(store, project.name, { session: 'R0NOSUCH' }), (e: unknown) => e instanceof JvError && e.exitCode === 3);
  assert.equal(chat.coordinatorChat.transcript, chat.coordinatorTranscript);
  assert.equal(chat.coordinatorChat.tail, chat.tailCoordinator);
  assert.equal(chat.coordinatorChat.message, chat.messageCoordinator);
});

test('transcript: a tool call that runs the installed jv by its path (as the coordinator prompt says) reads "ran jv ..."', async () => {
  const { paths } = await import('../src/paths.js');
  const shim = paths.shim;
  const bash = (command: string, jv?: string) => chat.toolSummary('Bash', JSON.stringify({ command }), ...(jv !== undefined ? [jv] : []));
  assert.equal(bash(`${shim} status --json --project shop`), 'ran jv status --json --project shop');
  assert.equal(bash(`cd /tmp && ${shim} task show T3K9QD --json`), 'ran cd /tmp && jv task show T3K9QD --json');
  assert.equal(bash(`"${shim}" report R1ABCDE`), 'ran "jv" report R1ABCDE');
  assert.equal(bash(`${shim}`), 'ran jv');
  // Only that exact path: a longer path, another jv, and arguments naming the path are left as they are.
  assert.equal(bash(`${shim}x status`), `ran ${shim}x status`);
  assert.equal(bash(`${shim}/x status`), `ran ${shim}/x status`);
  assert.equal(bash('/opt/other/bin/jv status'), 'ran /opt/other/bin/jv status');
  assert.equal(bash('/opt/jv/bin/jv status', '/opt/jv/bin/jv'), 'ran jv status');
  assert.equal(chat.toolSummary('Read', JSON.stringify({ file_path: shim })), `Read ${shim}`);

  const { project, file, msgDeps } = await started('transcript-shim');
  const r = await chat.messageCoordinator(store, 'transcript-shim', 'status', msgDeps);
  const t0 = Date.parse(r.typedAt);
  const iso = (ms: number) => new Date(t0 + ms).toISOString();
  writeFileSync(
    file,
    userLine('[owner]  status', iso(50)) +
      toolLine('s1', 'tu1', 'Bash', { command: `${shim} status --json --project transcript-shim` }, { input_tokens: 1, output_tokens: 1 }, iso(1000)) +
      resultLine('tu1', '{"tasks":[]}', iso(1500)) +
      textLine('s2', 'Nothing runs.', { input_tokens: 1, output_tokens: 1 }, iso(2500)),
  );
  const view = chat.coordinatorTranscript(store, project.name, { refresh: true });
  const tool = view.entries.find((e) => e.role === 'tool')!;
  assert.equal(tool.text, 'ran jv status --json --project transcript-shim');
  assert.equal(JSON.parse(tool.tool!.input).command, `${shim} status --json --project transcript-shim`, 'the full command stays in the input');
});

test('tail: an ended session is read to its end once and closed; the next coordinator is read on its own', async () => {
  const { project, session, file, tmux } = await started('tail-close');
  writeFileSync(file, textLine('e1', 'Bye.', { input_tokens: 1, output_tokens: 1 }));
  await c.stopCoordinator(store, 'tail-close', deps(tmux));
  const r = chat.tailCoordinator(store, { project: project.name });
  assert.deepEqual([r.projects[0]!.events, r.projects[0]!.closed], [2, true]);
  assert.equal(chat.readTailState(store, session.id).closed, true);
  appendFileSync(file, textLine('e2', 'Late.', { input_tokens: 1, output_tokens: 1 }));
  assert.deepEqual(chat.tailCoordinator(store, { project: project.name }).projects, [], 'a closed session is not read again');
  assert.equal(events(session.id).length, 2);

  const next = await c.startCoordinator(store, 'tail-close', deps(tmux));
  assert.notEqual(next.sessionId, session.id);
  const again = chat.tailCoordinator(store, { project: project.name });
  assert.deepEqual(again.projects.map((p) => p.session), [next.sessionId], 'only the new session is open');
  // The transcript view follows the current coordinator.
  assert.equal(chat.coordinatorTranscript(store, project.name).session, next.sessionId);
  assert.deepEqual(chat.coordinatorTranscript(store, project.name, { session: session.id }).entries.map((e) => e.text), ['Bye.']);

  // An ended session whose transcript never appeared is closed too.
  const ghost = store.createSession({
    request_id: `coordinator:${project.id}:ghost`,
    project_id: project.id,
    kind: 'coordinator',
    runtime: 'claude-tmux',
    provider: 'claude-main',
    model: 'claude-opus-5-5',
    effort: 'high',
    cwd: project.path,
    native_session_id: '00000000-0000-4000-8000-000000000000',
    state: 'failed',
    state_reason: 'test',
  }).row;
  const closed = chat.tailCoordinator(store, { project: project.name, session: ghost.id });
  assert.deepEqual(closed.projects, [{ project: 'tail-close', session: ghost.id, events: 0, offset: 0, closed: true }]);
});

test('tail: one unreadable transcript does not stop the others, and a shrunk transcript is never read twice', async () => {
  const a = await started('tail-shrink');
  writeFileSync(a.file, textLine('f1', 'First.', { input_tokens: 1, output_tokens: 1 }) + textLine('f2', 'Second.', { input_tokens: 1, output_tokens: 1 }));
  chat.tailCoordinator(store, { project: a.project.name });
  writeFileSync(a.file, textLine('g1', 'Short.', { input_tokens: 1, output_tokens: 1 }));
  const r = chat.tailCoordinator(store, { project: a.project.name });
  assert.equal(r.projects[0]!.offset, statSync(a.file).size);
  const kinds = events(a.session.id).map((e) => [e.kind, e.payload.text]);
  assert.equal(kinds.filter(([k]) => k === 'text').length, 2, 'nothing read again');
  assert.match(String(kinds.at(-1)![1]), /shrank/);

  // A transcript path that is a folder cannot be read; the error is that session's, the call goes on.
  const b = await started('tail-broken');
  mkdirSync(b.file, { recursive: true });
  writeFileSync(join(b.file, 'x'), 'x');
  const all = chat.tailCoordinator(store);
  const broken = all.projects.find((p) => p.project === 'tail-broken')!;
  assert.ok(broken.error, 'the error is reported');
  assert.ok(all.projects.some((p) => p.project === 'tail-shrink' && p.error === undefined));
});

test('typing lock: nested holds, a live holder makes others wait and give up (exit 4), a dead or stale holder is taken over', () => {
  const name = 'jv-coord-lock-test';
  const file = c.typingLockFile(name);
  assert.equal(file, join(home, 'run', 'typing-jv-coord-lock-test.lock'));
  const inner = c.withTypingLock(name, () => {
    assert.deepEqual(c.typingLockHolder(name)?.pid, process.pid);
    return c.withTypingLock(name, () => 'nested');
  });
  assert.equal(inner, 'nested');
  assert.equal(existsSync(file), false, 'released');
  assert.equal(c.typingLockHolder(name), undefined);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: 999_999, at: new Date().toISOString() }));
  const started = Date.now();
  assert.throws(
    () => c.withTypingLock(name, () => 'never', { waitMs: 100, alive: () => true }),
    (e: unknown) => e instanceof JvError && e.exitCode === 4 && /pid 999999 has been typing/.test(e.message),
  );
  assert.ok(Date.now() - started >= 100, 'it waited');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 999_999, 'a live holder keeps its lock');

  // The holder's pid is gone: taken over at once.
  assert.equal(c.withTypingLock(name, () => 'dead holder', { waitMs: 100, alive: () => false }), 'dead holder');
  // A holder alive for longer than the stale limit: taken over.
  writeFileSync(file, JSON.stringify({ pid: 999_999, at: new Date(Date.now() - c.TYPING_LOCK_STALE_MS - 1000).toISOString() }));
  assert.equal(c.withTypingLock(name, () => 'stale', { waitMs: 100, alive: () => true }), 'stale');
  // Our own pid left behind by an earlier crash of this process is not a holder.
  writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  assert.equal(c.typingLockHolder(name), undefined);
  assert.equal(c.withTypingLock(name, () => 'own leftover', { waitMs: 100 }), 'own leftover');
  assert.equal(existsSync(file), false);
});

test('typing lock: a wake line waits for the owner line another process is typing into the same window', async () => {
  const tmux = new FakeTmux();
  const name = 'jv-coord-two-processes';
  tmux.addForeign(name);
  const signal = join(home, 'child-holds-lock');
  const coordinatorUrl = new URL('../src/coordinator.js', import.meta.url).href;
  const script = [
    `import { writeFileSync } from 'node:fs';`,
    `const c = await import(${JSON.stringify(coordinatorUrl)});`,
    `c.withTypingLock(${JSON.stringify(name)}, () => {`,
    `  writeFileSync(${JSON.stringify(signal)}, 'held');`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);`,
    `});`,
  ].join('\n');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    env: { ...process.env, JV_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += String(d)));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const deadline = Date.now() + 20_000;
  while (!existsSync(signal) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(signal), `the child took the lock (${stderr})`);
  assert.equal(c.typingLockHolder(name)?.pid, child.pid);
  const t = Date.now();
  assert.equal(c.typeLine(tmux.run, name, '[jv] a wake line'), true);
  assert.ok(Date.now() - t >= 200, `typeLine waited for the other process (${Date.now() - t} ms)`);
  assert.deepEqual(tmux.sessions.get(name)!.submitted, ['[jv] a wake line']);
  assert.equal(await exited, 0, stderr);
  assert.equal(c.typingLockHolder(name), undefined);
});

test('tail: three processes tailing one transcript while it grows record every line exactly once', async () => {
  const { project, session, file } = await started('tail-race');
  writeFileSync(file, '');
  const stop = join(home, 'tail-race-stop');
  const storeUrl = new URL('../src/store.js', import.meta.url).href;
  const chatUrl = new URL('../src/coordinator-chat.js', import.meta.url).href;
  const script = [
    `import { existsSync } from 'node:fs';`,
    `const { openStore } = await import(${JSON.stringify(storeUrl)});`,
    `const chat = await import(${JSON.stringify(chatUrl)});`,
    `const store = openStore();`,
    `let reads = 0;`,
    `while (!existsSync(${JSON.stringify(stop)})) {`,
    `  chat.tailCoordinator(store, { project: ${JSON.stringify(project.name)} });`,
    `  reads++;`,
    `  await new Promise((r) => setTimeout(r, 1));`,
    `}`,
    `chat.tailCoordinator(store, { project: ${JSON.stringify(project.name)} });`,
    `store.close();`,
    `process.stdout.write(String(reads));`,
  ].join('\n');
  const children = [0, 1, 2].map(() => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
      env: { ...process.env, JV_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => child.on('exit', (code) => resolve({ code, out, err })));
  });
  const lines = 300;
  for (let i = 0; i < lines; i++) {
    const text = textLine(`race-${i}`, `line ${i}`, { input_tokens: 1, output_tokens: 1 });
    // Half the lines arrive in two writes, so readers see incomplete lines too.
    if (i % 2 === 0) appendFileSync(file, text);
    else {
      appendFileSync(file, text.slice(0, 15));
      await new Promise((r) => setTimeout(r, 1));
      appendFileSync(file, text.slice(15));
    }
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 2));
  }
  await new Promise((r) => setTimeout(r, 200));
  writeFileSync(stop, 'stop');
  const results = await Promise.all(children);
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.ok(results.every((r) => Number(r.out) > 0), 'every child read');
  chat.tailCoordinator(store, { project: project.name });
  const texts = events(session.id).filter((e) => e.kind === 'text').map((e) => String(e.payload.text));
  assert.equal(texts.length, lines, 'every line once');
  assert.deepEqual(texts, Array.from({ length: lines }, (_, i) => `line ${i}`), 'in transcript order');
  const row = store.getSession(session.id)!;
  assert.deepEqual([row.input_tokens, row.output_tokens], [lines, lines], 'usage counted once per message');
  assert.equal(chat.readTailState(store, session.id).offset, statSync(file).size);
});
