// jv worker-mcp --session R (internal): the stdio worker server (jv_report, jv_remember, jv_recall) of a claude-tmux
// or Codex session, started by the session's MCP config (M-015). Serves stdin until it closes.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagString } from '../command.js';
import { refused } from 'jevellan-core/errors';
import { normalizeId } from 'jevellan-core/ids';
import { SERVER_NAME, serve } from 'jevellan-core/report-mcp';

export async function run(args: ParsedArgs, _io: CommandIo): Promise<number> {
  const raw = flagString(args, 'session') ?? args.positionals[0];
  if (!raw) throw refused('jv worker-mcp --session R: the session id is required');
  await serve({ sessionId: normalizeId(raw), log: (text) => process.stderr.write(`${SERVER_NAME}: ${text}\n`) });
  return 0;
}
