import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, upcomingRuns, nextRun, validateCron } from '../lib/cron.mjs';

test('rejects malformed expressions', () => {
  assert.ok(validateCron('0 6 * *'));            // 4 fields
  assert.ok(validateCron('0 6 * * 8'));          // dow out of range
  assert.ok(validateCron('61 * * * *'));         // minute out of range
  assert.ok(validateCron('*/0 * * * *'));        // zero step
  assert.equal(validateCron('*/15 8-18 1,15 * 1-5'), null);
});

test('parses steps, ranges, and lists', () => {
  const cron = parseCron('*/15 8-10 1,15 * *');
  assert.deepEqual([...cron.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...cron.hour].sort((a, b) => a - b), [8, 9, 10]);
  assert.deepEqual([...cron.dom].sort((a, b) => a - b), [1, 15]);
});

test('day-of-week 7 means Sunday', () => {
  const fire = nextRun('0 12 * * 7', 'UTC', new Date('2026-07-13T00:00:00Z')); // a Monday
  assert.equal(fire.toISOString(), '2026-07-19T12:00:00.000Z'); // next Sunday
});

test('POSIX rule: restricted dom OR restricted dow', () => {
  // "13th of the month OR any Friday"
  const runs = upcomingRuns('0 0 13 * 5', 'UTC', new Date('2026-07-09T00:00:00Z'), 3)
    .map((d) => d.toISOString());
  // Jul 10 2026 is a Friday, Jul 13 a Monday, Jul 17 a Friday.
  assert.deepEqual(runs, [
    '2026-07-10T00:00:00.000Z',
    '2026-07-13T00:00:00.000Z',
    '2026-07-17T00:00:00.000Z',
  ]);
});

test('regression: spring-forward local day is not skipped', () => {
  // Mar 8 2026 is the US spring-forward day (23 wall-clock hours).
  const runs = upcomingRuns('30 23 * * *', 'America/New_York', new Date('2026-03-08T04:31:00Z'), 2)
    .map((d) => d.toISOString());
  assert.equal(runs[0], '2026-03-09T03:30:00.000Z'); // Mar 8, 23:30 EDT
  assert.equal(runs[1], '2026-03-10T03:30:00.000Z');
});

test('regression: fall-back day fires exactly once and offset shifts', () => {
  // Nov 1 2026 is the US fall-back day (25 wall-clock hours).
  const runs = upcomingRuns('30 23 * * *', 'America/New_York', new Date('2026-10-31T20:00:00Z'), 3)
    .map((d) => d.toISOString());
  assert.deepEqual(runs, [
    '2026-11-01T03:30:00.000Z', // Oct 31, 23:30 EDT
    '2026-11-02T04:30:00.000Z', // Nov 1, 23:30 EST — one fire, shifted offset
    '2026-11-03T04:30:00.000Z',
  ]);
  assert.equal(new Set(runs).size, runs.length);
});

test('search horizon: far-future occurrences return null, near ones resolve', () => {
  assert.equal(nextRun('0 0 29 2 *', 'UTC', new Date('2026-07-17T00:00:00Z')), null);
  const fire = nextRun('0 0 29 2 *', 'UTC', new Date('2027-06-01T00:00:00Z'));
  assert.equal(fire.toISOString(), '2028-02-29T00:00:00.000Z');
});

test('minute-level start boundary: a fire at "from" itself is excluded', () => {
  const fire = nextRun('0 12 * * *', 'UTC', new Date('2026-07-17T12:00:00Z'));
  assert.equal(fire.toISOString(), '2026-07-18T12:00:00.000Z');
});
