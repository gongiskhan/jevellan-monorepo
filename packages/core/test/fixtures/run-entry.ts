// The jv entry for detached processes in the core tests (launcher, runs, jv exec). jevellan-core cannot import the
// command layer (jevellan-cli depends on it, not the other way round), so this entry dispatches the two internal
// commands core starts itself: `run <R>` / `run --session R`, `exec --session R | --provider P [...] -- cmd` and
// `worker-mcp --session R` (the stdio worker server, M-015).
// Every core test that spawns a process sets JV_CLI_ENTRY to this file (jvEntry(), M-007).

import { executeRun } from '../../src/run.js';
import { planExec, runExec } from '../../src/exec.js';
import { normalizeId } from '../../src/ids.js';
import { openStore } from '../../src/store.js';
import { argSession, serve } from '../../src/report-mcp.js';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === 'run') {
    const raw = flag(argv, 'session') ?? argv[1];
    if (!raw) return 2;
    const outcome = await executeRun(normalizeId(raw));
    setTimeout(() => process.exit(outcome.exitCode), 2000).unref();
    return outcome.exitCode;
  }
  if (command === 'exec') {
    const dash = argv.indexOf('--');
    const head = dash >= 0 ? argv.slice(1, dash) : argv.slice(1);
    const cmd = dash >= 0 ? argv.slice(dash + 1) : [];
    const session = flag(head, 'session');
    const provider = flag(head, 'provider');
    const project = flag(head, 'project');
    const cwd = flag(head, 'cwd');
    const store = openStore();
    let plan;
    try {
      plan = planExec(store, {
        ...(session ? { sessionId: normalizeId(session) } : {}),
        ...(provider ? { providerName: provider } : {}),
        ...(project ? { projectName: project } : {}),
        ...(cwd ? { cwd } : {}),
        ...(head.includes('--home-login') ? { homeLogin: true } : {}),
        command: cmd,
      });
    } finally {
      store.close();
    }
    return runExec(plan);
  }
  if (command === 'worker-mcp') {
    const sessionId = argSession(argv.slice(1));
    if (!sessionId) return 2;
    await serve({ sessionId, log: (t) => process.stderr.write(`jv-worker-mcp: ${t}\n`) });
    return 0;
  }
  process.stderr.write(`core test entry: unknown command ${String(command)}\n`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
