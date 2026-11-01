// Building blocks the contract schemas share: store ids, ISO UTC times and JSON text columns.
//
// - Ids are one letter plus 6 characters of Crockford base32, upper case (ids.ts; the runtime's AGENTS.md lists the
//   letters). The pattern is written here rather than imported, because ids.ts imports node:crypto at load and the
//   contract modules should not run engine code.
// - Times are ISO 8601 UTC strings as new Date().toISOString() writes them (D-018).
// - JSON columns (*_json, events.payload) are strings holding JSON; jsonText checks that, and parses the content
//   with a schema when one is given.

import { z } from 'zod';
import type { IdPrefix } from '../ids.js';

const ID_BODY = '[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}';

/** A store id of one kind, for example idSchema('T') for task ids. */
export function idSchema(prefix: IdPrefix) {
  return z.string().regex(new RegExp(`^${prefix}${ID_BODY}$`), `an id: ${prefix} and 6 Crockford base32 characters`);
}

export const ProjectIdSchema = idSchema('P');
export const TaskIdSchema = idSchema('T');
export const StepIdSchema = idSchema('S');
export const SessionIdSchema = idSchema('R');
export const DecisionIdSchema = idSchema('D');
export const LandingIdSchema = idSchema('L');
export const MessageIdSchema = idSchema('M');
export const ReportIdSchema = idSchema('E');

/** An ISO 8601 UTC time (D-018). */
export const IsoTimeSchema = z.iso.datetime({ error: 'an ISO 8601 UTC time' });

/** A number of tokens or a count: an integer, zero or more. */
export const CountSchema = z.number().int().nonnegative();

/** A probability between 0 and 1. */
export const ProbabilitySchema = z.number().min(0).max(1);

/** A string that holds JSON (a *_json column); with `content`, the parsed value must match it too. */
export function jsonText(content?: z.ZodType) {
  return z.string().superRefine((text, ctx) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not JSON text' });
      return;
    }
    if (!content) return;
    const parsed = content.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 6)) {
        ctx.addIssue({ code: 'custom', message: `${issue.path.length ? issue.path.join('.') : '(json)'}: ${issue.message}` });
      }
    }
  });
}
