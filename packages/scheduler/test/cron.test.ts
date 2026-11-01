// The five-field cron of brief section 9: parsing and refusals, the Vixie day rule, next runs in UTC and in
// Europe/Lisbon across both daylight saving changes of 2026 (29 March forward, 25 October back), and "never fires".

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CronError, dayMatches, isTimeZone, nextRun, nextRuns, parseCron, resolveLocal, wallClock } from '../src/cron.js';

const iso = (d: Date) => d.toISOString();
const next = (cron: string, after: string, tz: string) => iso(nextRun(cron, new Date(after), tz));

describe('parsing', () => {
  test('fields, ranges, lists and steps', () => {
    const c = parseCron('*/15 9-17 1,15 1-12/3 1-5');
    assert.deepEqual([...c.minute.values], [0, 15, 30, 45]);
    assert.deepEqual([...c.hour.values], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
    assert.deepEqual([...c.dayOfMonth.values], [1, 15]);
    assert.deepEqual([...c.month.values], [1, 4, 7, 10]);
    assert.deepEqual([...c.dayOfWeek.values], [1, 2, 3, 4, 5]);
    assert.equal(c.minute.star, true);
    assert.equal(c.hour.star, false);
    assert.equal(parseCron('  0   3 * * *  ').text, '0 3 * * *');
    assert.deepEqual([...parseCron('0,30 * * * 0,6').dayOfWeek.values], [0, 6]);
  });

  test('refusals name the field and exit 2', () => {
    for (const bad of ['* * *', '* * * * * *', '', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 7', 'a * * * *', '* * * JAN *', '* * * * MON', '5-3 * * * *', '*/0 * * * *', '1/2 * * * *', '1,,2 * * * *', '1-2-3 * * * *']) {
      assert.throws(() => parseCron(bad), (e: unknown) => e instanceof CronError && e.exitCode === 2, bad);
    }
    assert.throws(() => parseCron('* 25 * * *'), /hour: 25 is outside 0-23/);
  });

  test('the Vixie rule: two restricted day fields fire on either; a field starting with * counts as unrestricted', () => {
    const both = parseCron('0 0 13 * 5');
    assert.equal(dayMatches(both, 11, 13, 5), true);
    assert.equal(dayMatches(both, 11, 6, 5), true, 'a Friday that is not the 13th');
    assert.equal(dayMatches(both, 11, 13, 2), true, 'a 13th that is not a Friday');
    assert.equal(dayMatches(both, 11, 7, 6), false);
    const starStep = parseCron('0 0 */2 * 1');
    assert.equal(dayMatches(starStep, 11, 9, 1), true, 'odd day and Monday');
    assert.equal(dayMatches(starStep, 11, 16, 1), false, 'a Monday on an even day: both must match');
  });
});

describe('next runs', () => {
  test('UTC', () => {
    assert.equal(next('0 3 * * *', '2026-11-01T12:00:00Z', 'UTC'), '2026-11-02T03:00:00.000Z');
    assert.equal(next('0 3 * * *', '2026-11-01T02:59:59Z', 'UTC'), '2026-11-01T03:00:00.000Z');
    assert.equal(next('0 3 * * *', '2026-11-01T03:00:00Z', 'UTC'), '2026-11-02T03:00:00.000Z', 'strictly after');
    assert.equal(next('* * * * *', '2026-11-01T12:00:30Z', 'UTC'), '2026-11-01T12:01:00.000Z');
    assert.equal(next('0 0 13 * 5', '2026-11-01T00:00:00Z', 'UTC'), '2026-11-06T00:00:00.000Z', 'Friday 6 November comes before the 13th');
    assert.equal(next('0 0 13 * *', '2026-11-01T00:00:00Z', 'UTC'), '2026-11-13T00:00:00.000Z');
    assert.equal(next('0 0 */2 * 1', '2026-11-01T00:00:00Z', 'UTC'), '2026-11-09T00:00:00.000Z');
    assert.equal(next('0 0 29 2 *', '2026-11-01T00:00:00Z', 'UTC'), '2028-02-29T00:00:00.000Z', 'a leap day within two years');
    assert.deepEqual(nextRuns('30 2 * * 1-5', new Date('2026-11-06T12:00:00Z'), 'UTC').map(iso), ['2026-11-09T02:30:00.000Z', '2026-11-10T02:30:00.000Z', '2026-11-11T02:30:00.000Z']);
  });

  test('a schedule that never fires is refused with exit 2', () => {
    assert.throws(() => nextRun('0 0 30 2 *', new Date('2026-11-01T00:00:00Z'), 'UTC'), (e: unknown) => e instanceof CronError && e.exitCode === 2 && /schedule never fires/.test(e.message));
    assert.throws(() => nextRun('0 0 31 4 *', new Date('2026-11-01T00:00:00Z'), 'Europe/Lisbon'), /schedule never fires/);
  });

  test('Europe/Lisbon in winter (WET, UTC+0) and summer (WEST, UTC+1)', () => {
    assert.equal(next('0 3 * * *', '2026-11-01T12:00:00Z', 'Europe/Lisbon'), '2026-11-02T03:00:00.000Z');
    assert.equal(next('0 3 * * *', '2026-07-01T12:00:00Z', 'Europe/Lisbon'), '2026-07-02T02:00:00.000Z');
  });

  test('25 October 2026, the clock goes back at 02:00 WEST: a fixed hour fires once, a wildcard hour fires on both passes', () => {
    // Local 01:00 to 01:59 happens twice: 00:00-00:59 UTC (WEST) and 01:00-01:59 UTC (WET).
    assert.deepEqual(resolveLocal(2026, 10, 25, 1, 30, 'Europe/Lisbon').instants.map((t) => new Date(t).toISOString()), ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
    assert.equal(next('30 1 * * *', '2026-10-24T12:00:00Z', 'Europe/Lisbon'), '2026-10-25T00:30:00.000Z');
    assert.equal(next('30 1 * * *', '2026-10-25T00:30:00Z', 'Europe/Lisbon'), '2026-10-26T01:30:00.000Z', 'not again at 01:30 WET');
    assert.equal(next('30 1 * * *', '2026-10-25T01:00:00Z', 'Europe/Lisbon'), '2026-10-26T01:30:00.000Z');
    assert.deepEqual(
      nextRuns('*/30 * * * *', new Date('2026-10-25T00:15:00Z'), 'Europe/Lisbon', 5).map(iso),
      ['2026-10-25T00:30:00.000Z', '2026-10-25T01:00:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-25T02:00:00.000Z', '2026-10-25T02:30:00.000Z'],
    );
    assert.equal(next('0 3 * * *', '2026-10-24T12:00:00Z', 'Europe/Lisbon'), '2026-10-25T03:00:00.000Z', 'after the change 03:00 is WET');
    assert.equal(next('0 3 * * *', '2026-10-23T12:00:00Z', 'Europe/Lisbon'), '2026-10-24T02:00:00.000Z', 'before it 03:00 is WEST');
  });

  test('29 March 2026, the clock jumps from 01:00 WET to 02:00 WEST: a fixed hour in the gap fires at the jump, a wildcard hour has no such minutes', () => {
    const gap = resolveLocal(2026, 3, 29, 1, 30, 'Europe/Lisbon');
    assert.deepEqual(gap.instants, []);
    assert.equal(new Date(gap.gapEnd!).toISOString(), '2026-03-29T01:00:00.000Z');
    assert.equal(next('30 1 * * *', '2026-03-28T12:00:00Z', 'Europe/Lisbon'), '2026-03-29T01:00:00.000Z');
    assert.equal(next('30 1 * * *', '2026-03-29T01:00:00Z', 'Europe/Lisbon'), '2026-03-30T00:30:00.000Z', 'the next day it is 01:30 WEST');
    assert.deepEqual(nextRuns('*/30 * * * *', new Date('2026-03-29T00:15:00Z'), 'Europe/Lisbon', 3).map(iso), ['2026-03-29T00:30:00.000Z', '2026-03-29T01:00:00.000Z', '2026-03-29T01:30:00.000Z']);
    const w = wallClock(Date.parse('2026-03-29T01:00:00Z'), 'Europe/Lisbon');
    assert.deepEqual([w.hour, w.minute], [2, 0]);
  });

  test('time zones', () => {
    assert.equal(isTimeZone('Europe/Lisbon'), true);
    assert.equal(isTimeZone('Mars/Olympus'), false);
    assert.throws(() => nextRun('0 3 * * *', new Date(), 'Mars/Olympus'), (e: unknown) => e instanceof CronError && e.exitCode === 2);
  });
});
