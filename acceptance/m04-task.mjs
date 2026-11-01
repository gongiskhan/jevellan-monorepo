// M4 One task end to end (brief section 14), on the sandbox with the real providers and Jev in a temporary JV_HOME:
// `jv task create --kind single --duty investigate`; Jev places it (a decision row with probabilities); the report
// lands in the store with the native session id; /t/<id> in the UI shows the report; no secret in the store, logs or
// evidence (the M16 grep, here on the temporary home).
//
// Usage: node acceptance/m04-task.mjs [--keep]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m04.json.

import { join } from 'node:path';
import {
  check,
  cleanup,
  finish,
  jvJson,
  leakCheck,
  log,
  note,
  parseFlags,
  query,
  queryOne,
  realJvHome,
  removeWorktreesUnder,
  runId,
  runJourney,
  SANDBOX,
  SANDBOX_NAME,
  startUi,
  stopChild,
  storeFile,
  uiPage,
  waitForTask,
} from './lib.mjs';

const JOURNEY = 'm04';

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { usage: 'node acceptance/m04-task.mjs [--keep]' });
  const started = Date.now();
  const id = runId(JOURNEY);
  log(`M4 One task end to end ${id}`);
  let home;
  let ui;
  let taskId;
  try {
    home = realJvHome(id).home;
    await check('jv task create --kind single --duty investigate on the sandbox', () => {
      const r = jvJson(
        ['task', 'create', '--project', SANDBOX_NAME, '--kind', 'single', '--duty', 'investigate', '--title', 'Where do invoice totals come from', '--text', 'Which function computes an invoice total in this project, and in which file and line? Read the code; change nothing. Report the file and line.'],
        { home, timeoutMs: 180_000 },
      );
      taskId = r.json?.task?.id;
      return { ok: r.code === 0 && !!taskId, detail: r.code === 0 ? `${taskId}: ${r.json.start?.state ?? ''}` : r.stderr || r.stdout };
    });

    await check('Jev placed it: a placement decision row with probabilities', () => {
      const d = queryOne(storeFile(home), "SELECT id, jev_model, answers_json, chosen_json FROM decisions WHERE task_id = ? AND kind = 'placement' ORDER BY created_at LIMIT 1", taskId);
      if (!d) return { ok: false, detail: 'no placement decision' };
      const answers = JSON.parse(d.answers_json);
      const text = JSON.stringify(answers);
      const chosen = JSON.parse(d.chosen_json);
      return { ok: /probabilit/i.test(text) || /"p(rob)?"\s*:/.test(text), detail: `${d.id} by ${d.jev_model}: ${chosen.model ?? ''} ${chosen.effort ?? ''} on ${chosen.provider ?? ''}` };
    });

    let session;
    await check('the step runs to done and its report is in the store with the native session id', async () => {
      const end = await waitForTask(home, taskId, ['done', 'failed', 'stopped', 'waiting-owner'], { timeoutMs: 15 * 60_000 });
      session = queryOne(storeFile(home), 'SELECT s.id, s.native_session_id, r.status, r.summary FROM sessions s JOIN reports r ON r.session_id = s.id WHERE s.task_id = ? ORDER BY s.created_at DESC LIMIT 1', taskId);
      return { ok: end?.state === 'done' && !!session?.native_session_id && !!session?.summary, detail: `${taskId} ${end?.state}; ${session?.id} native ${session?.native_session_id ?? 'none'}; report ${session?.status}: ${(session?.summary ?? '').slice(0, 120)}` };
    });

    await check('/t/<id> in the UI shows the report', async () => {
      ui = await startUi(home);
      const { browser, page } = await uiPage(ui);
      try {
        await page.goto(`${ui.url}/t/${taskId}`);
        const words = (session?.summary ?? '').replace(/[`*_#>[\]()]/g, ' ').split(/\s+/).filter((w) => w.length > 4).slice(0, 4);
        for (const w of words) await page.getByText(w, { exact: false }).first().waitFor({ timeout: 20_000 });
        const shot = join(home, '..', 'm04-task.png');
        await page.screenshot({ path: shot, fullPage: true });
        return { ok: true, detail: `page shows ${words.join(', ')}` };
      } finally {
        await browser.close();
      }
    });

    await check('no secret in the store, its WAL, the logs or the evidence of the temporary home', () => {
      const file = storeFile(home);
      const evidence = query(file, 'SELECT worktree_path FROM tasks WHERE worktree_path IS NOT NULL').map((r) => join(r.worktree_path, '.jv-evidence'));
      const r = leakCheck([file, `${file}-wal`, join(home, 'logs'), ...evidence], { secretsDir: join(home, 'secrets') });
      return { ok: r.secrets > 0 && r.leaks.length === 0 && r.errors.length === 0, detail: `${r.secrets} key files against ${r.checked.length} paths${r.leaks.length ? `; found in ${r.leaks.map((l) => l.file).join(', ')}` : ''}` };
    });
  } finally {
    if (ui) await stopChild(ui.child);
    if (home) note(`worktrees removed from the sandbox: ${removeWorktreesUnder(SANDBOX, home).length}`);
    if (!flags.keep) cleanup(id);
  }
  return finish(JOURNEY, { startedAt: started, mode: 'real providers in a temporary JV_HOME' });
}

runJourney(JOURNEY, main);
