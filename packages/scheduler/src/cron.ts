// Five-field cron, parsed here with no dependency (brief section 9): minute, hour, day of month, month, day of week.
// Each field is `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, or a list of those `a,b,c`; names are not
// accepted; day of week is 0 to 6 with 0 Sunday. When both day fields are restricted, either matching fires (the
// Vixie cron rule; a field that starts with `*`, such as `*/2`, counts as unrestricted, as in Vixie cron).
//
// nextRun(cron, after, tz) is the first minute strictly after `after` whose wall clock in the IANA zone `tz` matches,
// computed with Intl.DateTimeFormat parts (no library), within two years; otherwise it throws "schedule never
// fires". Daylight saving time (M-016), as Vixie cron treats it:
// - a local time that does not exist (the clock jumps forward over it): a job with a fixed hour fires once, at the
//   first instant after the jump; a job whose hour field is a wildcard simply has no such minutes;
// - a local time that happens twice (the clock goes back): a job with a fixed hour fires at the first of the two
//   instants only; a job whose hour field is a wildcard fires at both.
//
// This module has no Node imports, so the web app can use it for the "next three runs" helper.

export class CronError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export interface CronField {
  values: ReadonlySet<number>;
  /** The field text starts with `*` (unrestricted for the day-of-month / day-of-week rule). */
  star: boolean;
  text: string;
}

export interface Cron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  text: string;
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 },
] as const;

function int(text: string, field: (typeof FIELDS)[number]): number {
  if (!/^\d+$/.test(text)) throw new CronError(`${field.name}: "${text}" is not a number (names are not accepted)`);
  const n = Number(text);
  if (n < field.min || n > field.max) throw new CronError(`${field.name}: ${n} is outside ${field.min}-${field.max}`);
  return n;
}

function parseField(text: string, field: (typeof FIELDS)[number]): CronField {
  if (text === '') throw new CronError(`${field.name} is empty`);
  const values = new Set<number>();
  for (const part of text.split(',')) {
    if (part === '') throw new CronError(`${field.name}: an empty item in "${text}"`);
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`${field.name}: "${part}" has more than one step`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new CronError(`${field.name}: step "${stepText}" must be a whole number of at least 1`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === '*') {
      from = field.min;
      to = field.max;
    } else if (range!.includes('-')) {
      const [a, b, more] = range!.split('-');
      if (more !== undefined || a === undefined || b === undefined) throw new CronError(`${field.name}: "${range}" is not a range a-b`);
      from = int(a, field);
      to = int(b, field);
      if (from > to) throw new CronError(`${field.name}: range ${from}-${to} runs backwards`);
    } else {
      if (stepText !== undefined) throw new CronError(`${field.name}: a step needs * or a range ("${part}")`);
      from = to = int(range!, field);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, star: text.startsWith('*'), text };
}

/** Parses a five-field cron expression; throws CronError (exit 2) naming the field. */
export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === '') throw new CronError(`a cron needs five fields (minute hour day-of-month month day-of-week), got ${parts[0] === '' ? 0 : parts.length}: "${text.trim()}"`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as [CronField, CronField, CronField, CronField, CronField];
  return { minute, hour, dayOfMonth, month, dayOfWeek, text: parts.join(' ') };
}

/** Whether a calendar day (local) matches the day fields, with the Vixie rule for two restricted day fields. */
export function dayMatches(cron: Cron, month: number, day: number, weekday: number): boolean {
  if (!cron.month.values.has(month)) return false;
  const dom = cron.dayOfMonth.values.has(day);
  const dow = cron.dayOfWeek.values.has(weekday);
  // Vixie cron: when either day field starts with *, both must match (a plain * matches every day anyway).
  if (cron.dayOfMonth.star || cron.dayOfWeek.star) return dom && dow;
  return dom || dow;
}

// ---- time zones -------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        weekday: 'short',
      });
    } catch {
      throw new CronError(`"${tz}" is not an IANA time zone`);
    }
    formatters.set(tz, f);
  }
  return f;
}

/** Whether `tz` is a time zone this runtime knows. */
export function isTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** This machine's IANA time zone. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

/** The wall clock of an instant in a zone. */
export function wallClock(instant: number, tz: string): WallClock {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(instant))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
  };
}

/** The zone's offset from UTC at an instant, in ms (Lisbon summer: +3 600 000). */
export function zoneOffset(instant: number, tz: string): number {
  const w = wallClock(instant, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * The instants at which the zone's wall clock reads y-mo-d h:mi: none in a jump forward, two when the clock goes back,
 * one otherwise. `gapEnd` is the first instant after the jump when there is none.
 */
export function resolveLocal(y: number, mo: number, d: number, h: number, mi: number, tz: string): { instants: number[]; gapEnd?: number } {
  const t0 = Date.UTC(y, mo - 1, d, h, mi);
  const offsets = [...new Set([zoneOffset(t0 - DAY, tz), zoneOffset(t0, tz), zoneOffset(t0 + DAY, tz)])];
  const instants = [...new Set(offsets.map((o) => t0 - o))]
    .filter((c) => {
      const w = wallClock(c, tz);
      return w.year === y && w.month === mo && w.day === d && w.hour === h && w.minute === mi;
    })
    .sort((a, b) => a - b);
  if (instants.length > 0) return { instants };
  // A jump forward: find the transition between the earliest and latest candidate instants by bisection.
  const before = Math.min(...offsets.map((o) => t0 - o));
  const after = Math.max(...offsets.map((o) => t0 - o));
  let lo = before - 2 * HOUR;
  let hi = after + 2 * HOUR;
  const offLo = zoneOffset(lo, tz);
  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
    if (zoneOffset(mid, tz) === offLo) lo = mid;
    else hi = mid;
  }
  return { instants: [], gapEnd: hi };
}

const MAX_DAYS = 2 * 366 + 1;

/**
 * The next instant strictly after `after` (to the minute) at which the cron fires in zone `tz`. Throws CronError
 * "schedule never fires" when nothing matches within two years (for example 30 February).
 */
export function nextRun(cron: string | Cron, after: Date, tz: string): Date {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  const start = after.getTime();
  const w = wallClock(start, tz);
  const hours = [...c.hour.values].sort((a, b) => a - b);
  const minutes = [...c.minute.values].sort((a, b) => a - b);
  const fixedHour = !c.hour.star;
  // Walk local calendar days from the day of `after` (from the day before, so a time the clock went back over is seen).
  const firstDay = Date.UTC(w.year, w.month - 1, w.day) - DAY;
  for (let i = 0; i <= MAX_DAYS; i++) {
    const day = new Date(firstDay + i * DAY);
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!dayMatches(c, mo, d, day.getUTCDay())) continue;
    // On a day without a clock change, wall-clock order is time order and the first match is the answer; on the day
    // the clock goes back it is not (01:30 WEST comes before 01:00 WET), so every candidate of that day is compared.
    const dayStart = Date.UTC(y, mo - 1, d);
    const steady = zoneOffset(dayStart - 12 * HOUR, tz) === zoneOffset(dayStart + 36 * HOUR, tz);
    let best: number | undefined;
    for (const h of hours) {
      for (const mi of minutes) {
        const r = resolveLocal(y, mo, d, h, mi, tz);
        const candidates = r.instants.length ? (fixedHour ? [r.instants[0]!] : r.instants) : fixedHour && r.gapEnd !== undefined ? [r.gapEnd] : [];
        for (const t of candidates) {
          if (t <= start) continue;
          if (steady) return new Date(t);
          if (best === undefined || t < best) best = t;
        }
      }
    }
    if (best !== undefined) return new Date(best);
  }
  throw new CronError(`schedule never fires: "${c.text}" matches no time in the next two years`);
}

/** The next `count` runs after `after` (for the UI's helper and jv schedule show). */
export function nextRuns(cron: string | Cron, after: Date, tz: string, count = 3): Date[] {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  const out: Date[] = [];
  let from = after;
  for (let i = 0; i < count; i++) {
    const t = nextRun(c, from, tz);
    out.push(t);
    from = t;
  }
  return out;
}
