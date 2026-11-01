// jv report S: prints a session's report (text, or the section 5 shape with --json).

import type { CommandIo, ParsedArgs } from '../command.js';
import { requirePositional } from '../command.js';
import { normalizeId } from 'jevellan-core/ids';
import { formatReport, sessionReport } from 'jevellan-core/report';
import { openStore } from 'jevellan-core/store';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const id = normalizeId(requirePositional(args, 0, 'the session id (jv report S)'));
  const store = openStore();
  try {
    const view = sessionReport(store, id);
    io.result(view, () => formatReport(view));
    return 0;
  } finally {
    store.close();
  }
}
