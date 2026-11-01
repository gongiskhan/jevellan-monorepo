// jv improve memory|docs|skills --project N [--force] (brief sections 4 and 10): shorthand for jv job run
// improve-<x>, with the same rules, output and exit codes (job.ts). improve-skills always runs on the registered
// project jevellan-skills, so --project is not needed for it; until that project is registered it is refused (exit 2)
// with the jv project add line that registers it.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagBool, flagString } from '../command.js';
import { refused } from 'jevellan-core/errors';
import { openStore } from 'jevellan-core/store';
import { formatRunJob, runJob } from './job.js';

export const IMPROVE_USAGE = 'jv improve memory|docs|skills --project N [--force]';
const WHAT = ['memory', 'docs', 'skills'] as const;

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const what = args.positionals[0];
  if (!(WHAT as readonly string[]).includes(what ?? '')) throw refused(what === undefined ? IMPROVE_USAGE : `unknown subcommand "improve ${what}". ${IMPROVE_USAGE}`);
  const store = openStore();
  try {
    const project = flagString(args, 'project');
    const r = runJob(store, { kind: `improve-${what}`, ...(project ? { project } : {}), force: flagBool(args, 'force') });
    io.result(r, () => formatRunJob(r));
    return 0;
  } finally {
    store.close();
  }
}
