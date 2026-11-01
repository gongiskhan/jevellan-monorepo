// The public contracts of jevellan-core (brief section 3), one module each, with a fixture each under
// test/fixtures/contracts/ that the UI, MCP and memory tests reuse:
//
//   report.ts       the report a worker sends (skills brief 5) plus the A2UI `ui` field, and a stored report
//   placement.ts    the placement and workflow state JSON, the landing state, the decisions row (7.2, 7.5, 8)
//   events.ts       the event kinds and the events row (6.1)
//   exit-codes.ts   the exit codes and the --json error (3)
//   request-ids.ts  the request id rule and the forms jv writes (4, D-019, D-038)
//   wake.ts         the wake line (9.4)
//   providers.ts    providers.json (6.6, D-011)
//   status.ts       jv status --json
//   task-show.ts    jv task show --json
//
// Where the lifted runtime already has a zod schema (the report, providers.json, the landing state, Jev's questions
// and answers) it is re-exported, never copied; the others are written here and tested against what the lifted code
// produces. The shared worker rules and prompt assembly (7.4) are text, not JSON: their contract is prompt.ts and
// templates/worker-rules.md, tested by prompt.test.ts.

export * from './common.js';
export * from './events.js';
export * from './exit-codes.js';
export * from './placement.js';
export * from './providers.js';
export * from './report.js';
export * from './request-ids.js';
export * from './status.js';
export * from './task-show.js';
export * from './wake.js';
