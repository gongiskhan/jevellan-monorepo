// jv bootstrap [--skills PATH] [--node PATH] and jv update: install this checkout as the jv of $JV_HOME (M-007).
// The work is jevellan-core's bootstrap(); this prints its summary. `jv update` re-runs it from the recorded
// checkout, skills checkout and Node binary and never opens the store.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagString } from '../command.js';
import { bootstrap } from 'jevellan-core/bootstrap';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const update = args.command === 'update';
  const skills = flagString(args, 'skills');
  const node = flagString(args, 'node');
  const summary = await bootstrap({
    update,
    ...(skills !== undefined ? { skills } : {}),
    ...(node !== undefined ? { node } : {}),
    log: (line) => io.info(`[jv ${update ? 'update' : 'bootstrap'}] ${line}`),
  });
  io.result(summary, () => {
    const i = summary.install;
    const lines = [
      `jv ${i.version} ${update ? 'updated' : 'installed'} in ${summary.jvHome} from ${i.checkout}`,
      `node ${i.nodePath}`,
      `skills ${i.skillsVersion ?? 'unknown'} from ${i.skillsSource}${i.skillsCommit ? ` at ${i.skillsCommit.slice(0, 7)}` : ''} (${summary.skillNames.length} skills${summary.skillsCopied ? ', copied' : ', unchanged'})`,
    ];
    if (summary.archived.length) lines.push(`moved aside: ${summary.archived.join(', ')}`);
    lines.push(summary.onPath ? `${summary.shim} is on PATH already.` : `Add jv to PATH (for example in ~/.zprofile):\n${summary.pathLine}`);
    return lines.join('\n');
  });
  return 0;
}
