// The event contract (skills brief 6.1; brief section 3): the kinds a session's event stream may hold and the events
// row. recordEvent (events.ts) is the one write path: it redacts, cuts strings at 20000 characters (and sets
// `truncated`), assigns seq per session from 1, and stores the payload as JSON text. Payloads differ per runtime;
// the two the store itself reads are typed here: `usage` (deltas added to the session's counters, D-027) and
// `rate-limit` (written to provider_usage). Both stay open to more keys, as events.ts declares them.

import { z } from 'zod';
import { EVENT_KINDS } from '../types.js';
import { CountSchema, IsoTimeSchema, SessionIdSchema, jsonText } from './common.js';

export { EVENT_KINDS };

export const EventKindSchema = z.enum(EVENT_KINDS);

/** An events row (section 4): payload as JSON text. */
export const EventRowSchema = z.strictObject({
  id: z.number().int().positive(),
  session_id: SessionIdSchema,
  seq: z.number().int().positive(),
  at: IsoTimeSchema,
  kind: EventKindSchema,
  payload: jsonText(),
});
export type EventRowContract = z.output<typeof EventRowSchema>;

/** Payload of a `usage` event: this turn's deltas (events.ts UsagePayload). */
export const UsagePayloadSchema = z.looseObject({
  inputTokens: CountSchema.optional(),
  outputTokens: CountSchema.optional(),
  cacheReadTokens: CountSchema.optional(),
  cacheWriteTokens: CountSchema.optional(),
  costUsd: z.number().nonnegative().optional(),
});

/** Payload of a `rate-limit` event (events.ts RateLimitPayload). */
export const RateLimitPayloadSchema = z.looseObject({
  fiveHourPct: z.number().optional(),
  weeklyPct: z.number().optional(),
  fiveHourResetsAt: IsoTimeSchema.optional(),
  weeklyResetsAt: IsoTimeSchema.optional(),
});

/** An events row whose payload also matches its kind, where the store reads the payload (usage, rate-limit). */
export const EventSchema = EventRowSchema.superRefine((row, ctx) => {
  const schema = row.kind === 'usage' ? UsagePayloadSchema : row.kind === 'rate-limit' ? RateLimitPayloadSchema : undefined;
  if (!schema) return;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return; // EventRowSchema reported it
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 6)) ctx.addIssue({ code: 'custom', path: ['payload', ...issue.path], message: issue.message });
  }
});
