// The exit code contract (skills brief section 3; the runtime's AGENTS.md): 0 ok, 2 refused with a reason, 3 not
// found, 4 conflict (a request id reused with different input), and 1 for an unexpected error. core never exits: it
// throws JvError with one of 2, 3 or 4 and the command layer maps it. With --json a failing command prints
// {"error": <message, redacted>, "exitCode": <code>} on stdout (cli.ts), the shape every caller of `jv ... --json`
// (the coordinator, the MCP, the UI) reads.

import { z } from 'zod';
import { EXIT } from '../errors.js';

export { EXIT };

/** Every code a jv command exits with. */
export const ExitCodeSchema = z.union([
  z.literal(EXIT.ok),
  z.literal(EXIT.failure),
  z.literal(EXIT.refused),
  z.literal(EXIT.notFound),
  z.literal(EXIT.conflict),
]);

/** The codes a JvError carries (core's refusals). */
export const JvExitCodeSchema = z.union([z.literal(EXIT.refused), z.literal(EXIT.notFound), z.literal(EXIT.conflict)]);

/** What a failing command prints with --json. */
export const CliErrorSchema = z.strictObject({
  error: z.string().min(1),
  exitCode: z.union([z.literal(EXIT.failure), JvExitCodeSchema]),
});
export type CliError = z.output<typeof CliErrorSchema>;
