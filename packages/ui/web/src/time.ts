// Time helpers of the web app, ported from gongiskhan/jevellan at 8e2788ec (apps/web/src/time.ts) and extended with
// the jv text rule (brief section 4): times are local HH:MM on the 24-hour clock (D-065), with the date only when it
// is not today. `now` is a parameter so the checks can fix the clock.

/** Compact age of a timestamp: `now`, `5m`, `3h`, a weekday within a week, else a day and month. */
export const shortTime = (at: string, now = Date.now()): string => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10_080) return new Date(at).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** A length of time in seconds: `45s`, `3m 20s`, `2h 5m 0s`. */
export const duration = (seconds: number): string =>
  seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;

/** Elapsed time from `from` to `to` in its two largest units, for list rows: `45s`, `12m`, `2h 5m`, `3d 4h`. */
export function relativeDuration(from: string, to: string | number = Date.now()): string {
  const end = typeof to === 'number' ? to : Date.parse(to);
  const seconds = Math.max(0, Math.floor((end - Date.parse(from)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  return spanText(seconds);
}

/** Seconds in their two largest units: `45s`, `12m`, `2h 5m`, `3d 4h`. */
export function spanText(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** A calendar date in the reader's locale, such as `Oct 4, 2026`. */
export const dateOnly = (value: string): string => new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });

const fullStamp = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'long' });
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/** HH:MM local time for the end of a chat response, with the full local date and time for its title; null when unreadable. */
export function clockStamp(value: string): { label: string; title: string } | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? { label: clockFormat.format(date), title: fullStamp.format(date) } : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local `HH:MM`, or `YYYY-MM-DD HH:MM` when the time is not today; '' when unreadable or null. */
export function localTime(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date(now);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? time : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** The full local date and time, for a title attribute. */
export function fullTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? fullStamp.format(date) : '';
}

/** A time since an ISO instant as "4 s ago", "3 min ago", "2 h ago" or "5 d ago". */
export function agoText(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return '';
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  return `${secondsText(seconds)} ago`;
}

/** Seconds as "4 s", "3 min", "2 h" or "5 d". */
export function secondsText(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

/** Milliseconds as a short duration: `850 ms`, `12 s`, `3m 20s`. */
export function msText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : duration(seconds);
}
