// The time at the end of an assistant turn (the coordinator's and a step's): local HH:MM, the full date on hover, and
// how long the turn took when known. Ported from gongiskhan/jevellan at 8e2788ec (apps/web/src/response-time.tsx).

import { clockStamp, msText } from './time.js';

export function ResponseTime({ at, tookMs }: { at: string; tookMs?: number | null | undefined }) {
  const stamp = clockStamp(at);
  if (!stamp) return null;
  const took = msText(tookMs);
  return (
    <p className="response-time">
      <time dateTime={at} title={stamp.title}>{stamp.label}</time>
      {took && <span className="response-took"> · {took}</span>}
    </p>
  );
}
