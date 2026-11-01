// /usage (brief section 7, jv usage): provider usage by ISO week and provider: the newest weekly and five-hour
// percentages the probes and the streams saw, and the token and cost sums of the sessions that started in the week.
// GET /api/usage?week=; the week moves with Previous and Next.

import { useState } from 'react';
import { getUsage, useResource } from '../api.js';
import { ErrorLine, Loading, PageHeading } from '../components.js';
import { Icon } from '../icons.js';
import { localTime } from '../time.js';
import type { ProviderUsageRow, UsageWeek } from '../types.js';

/** The ISO week (2026-W44) of a date, as core's usage module counts it. */
export function isoWeek(at: Date): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The week `delta` weeks from `week`. */
export function shiftWeek(week: string, delta: number): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return week;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000 + (Number(m[2]) - 1) * 7 * 86_400_000);
  return isoWeek(new Date(monday.getTime() + delta * 7 * 86_400_000 + 3 * 86_400_000));
}

const pct = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${Math.round(n)}%`);
const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function newest(...rows: Array<ProviderUsageRow | null>): ProviderUsageRow | null {
  return rows.filter((r): r is ProviderUsageRow => r !== null).sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0] ?? null;
}

function UsageTable({ week }: { week: UsageWeek }) {
  if (!week.providers.length) return <p className="empty-inline">No usage recorded this week.</p>;
  return (
    <div className="table-scroll">
      <table className="usage-table">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Week</th>
            <th scope="col">5 h</th>
            <th scope="col">Sessions</th>
            <th scope="col">Tokens</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {week.providers.map((p) => {
            const seen = newest(p.probe, p.stream);
            const s = p.sessions;
            return (
              <tr key={p.provider}>
                <th scope="row">
                  {p.provider}
                  {seen && <span className="muted small-text usage-seen"> seen {localTime(seen.observed_at)}</span>}
                </th>
                <td data-label="Week">{pct(seen?.weekly_pct)}</td>
                <td data-label="5 h">{pct(seen?.five_hour_pct)}</td>
                <td data-label="Sessions">{s?.sessions ?? 0}</td>
                <td data-label="Tokens">{s ? `${k(s.inputTokens)} in, ${k(s.outputTokens)} out` : '-'}</td>
                <td data-label="Cost">{s?.costUsd !== null && s?.costUsd !== undefined ? `$${s.costUsd.toFixed(2)}` : '-'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function UsagePage() {
  const [week, setWeek] = useState(() => isoWeek(new Date()));
  const usage = useResource(`usage:${week}`, (signal) => getUsage(week, signal));
  return (
    <div className="list-page usage-page">
      <PageHeading title="Usage" intro="Provider usage by week: what the probes and streams saw, and the sessions that started in the week." />
      <div className="filter-bar week-bar">
        <button type="button" className="secondary small" aria-label="Previous week" onClick={() => setWeek(shiftWeek(week, -1))}>
          <Icon name="back" size={14} />
          Previous
        </button>
        <label className="compact-label">
          <span className="sr-only">Week</span>
          <input aria-label="Week" className="mono week-input" value={week} onChange={(event) => setWeek(event.target.value)} />
        </label>
        <button type="button" className="secondary small next-week" aria-label="Next week" onClick={() => setWeek(shiftWeek(week, 1))}>
          Next
          <Icon name="back" size={14} />
        </button>
        {usage.data && (
          <span className="muted small-text">
            {usage.data.from.slice(0, 10)} to {usage.data.to.slice(0, 10)}
          </span>
        )}
      </div>
      <ErrorLine text={usage.error} />
      {!usage.data && usage.loading && <Loading />}
      {usage.data && (
        <section className="card" aria-label={`Usage in ${usage.data.week}`}>
          <UsageTable week={usage.data} />
        </section>
      )}
    </div>
  );
}
