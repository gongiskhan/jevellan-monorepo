#!/usr/bin/env node
// The jv-mcp executable of jevellan-mcp: the control MCP without the jv command, with the flags of `jv mcp` (brief
// section 5; serve.ts does the work for both): stdio by default, --http [--port 7072] [--bind 127.0.0.1],
// --token-reset, --json. Like every jv process (M-015) it first registers jevellan-memory as jevellan-core's memory
// port and as the store's schema extension, so the memory tools work on a store this process creates. Exit codes as
// jv's: 0 ok, 2 refused, 3 not found, 4 conflict, 1 unexpected.

import { registerMemory } from 'jevellan-core/memory-port';
import { registerSchemaExtension } from 'jevellan-core/store';
import * as memory from 'jevellan-memory';

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

registerSchemaExtension(memory.memorySchemaExtension);
registerMemory(memory);

const USAGE = 'jv-mcp [--stdio] [--http [--port 7072] [--bind 127.0.0.1]] [--token-reset] [--json]';

interface Parsed {
  stdio: boolean;
  http: boolean;
  tokenReset: boolean;
  json: boolean;
  help: boolean;
  port?: number;
  bind?: string;
}

class UsageError extends Error {}

function parse(argv: readonly string[]): Parsed {
  const out: Parsed = { stdio: false, http: false, tokenReset: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--stdio':
        out.stdio = true;
        break;
      case '--http':
        out.http = true;
        break;
      case '--token-reset':
        out.tokenReset = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--port': {
        const v = value();
        if (!/^\d+$/.test(v)) throw new UsageError('--port needs a whole number');
        out.port = Number(v);
        break;
      }
      case '--bind':
        out.bind = value();
        break;
      default:
        throw new UsageError(`unknown argument ${flag}`);
    }
  }
  return out;
}

async function main(argv: readonly string[]): Promise<number> {
  const { JvError } = await import('jevellan-core/errors');
  try {
    const args = parse(argv);
    if (args.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (args.stdio && args.http) throw new UsageError('give --stdio or --http, not both');
    const { runMcpCommand } = await import('./serve.js');
    const mode = args.http ? 'http' : args.tokenReset && !args.stdio ? 'token-reset' : 'stdio';
    return await runMcpCommand(
      {
        mode,
        tokenReset: args.tokenReset,
        json: args.json,
        ...(args.port !== undefined ? { port: args.port } : {}),
        ...(args.bind !== undefined ? { bind: args.bind } : {}),
      },
      { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) },
    );
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`jv-mcp: ${error.message}\n${USAGE}\n`);
      return 2;
    }
    const { redact } = await import('jevellan-core/redact');
    const message = redact(error instanceof Error ? error.message : String(error));
    process.stderr.write(`jv-mcp: ${message}\n`);
    return error instanceof JvError ? error.exitCode : 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`jv-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
