// jv mcp [--stdio] [--http [--port 7072] [--bind 127.0.0.1]] [--token-reset] (brief sections 4 and 5): the control
// MCP, loaded lazily from jevellan-mcp so the other commands start without it. stdio (the default) serves until the
// client closes stdin and writes nothing but the protocol to stdout; --http serves Streamable HTTP with the bearer
// token, one per JV_HOME ($JV_HOME/run/mcp.pid); --token-reset rotates the token. jevellan-mcp's serve.ts does the
// work, the same code the jv-mcp bin runs.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagBool, flagInt, flagString } from '../command.js';
import { refused } from 'jevellan-core/errors';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  if (args.positionals.length) throw refused(`jv mcp takes no words (got "${args.positionals.join(' ')}"): jv mcp [--stdio] [--http [--port N] [--bind A]] [--token-reset]`);
  const stdio = flagBool(args, 'stdio');
  const http = flagBool(args, 'http');
  const tokenReset = flagBool(args, 'token-reset');
  if (stdio && http) throw refused('give --stdio or --http, not both');
  const port = flagInt(args, 'port');
  const bind = flagString(args, 'bind');
  const { runMcpCommand } = await import('jevellan-mcp/serve');
  return runMcpCommand(
    {
      mode: http ? 'http' : tokenReset && !stdio ? 'token-reset' : 'stdio',
      tokenReset,
      json: io.json,
      ...(port !== undefined ? { port } : {}),
      ...(bind !== undefined ? { bind } : {}),
    },
    { out: (text) => io.write(`${text}\n`), err: (text) => io.warn(text) },
  );
}
