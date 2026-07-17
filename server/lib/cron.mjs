// Minimal POSIX cron evaluation (minute hour day-of-month month day-of-week)
// with IANA timezone support. Wall-clock matching, minute granularity —
// mirrors the scheduled-deployments semantics we reproduce. Near DST
// transitions, times are resolved from the day's midday offset, so the
// nonexistent spring-forward hour resolves forward rather than being skipped.

const FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 },  // day of week (0 and 7 are Sunday)
];

function parseField(text, { min, max }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const [rangeText, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in "${part}"`);
    let lo = min;
    let hi = max;
    if (rangeText !== '*') {
      const [a, b] = rangeText.split('-');
      lo = Number(a);
      hi = b === undefined ? (stepText === undefined ? Number(a) : max) : Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`value out of range in "${part}"`);
      }
    }
    for (let v = lo; v <= hi; v += step) values.add(v === 7 && max === 7 ? 0 : v);
  }
  return values;
}

export function parseCron(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron expression must have 5 fields');
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, FIELD_RANGES[i]));
  return {
    minute, hour, dom, month, dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

const partCache = new Map();
function formatterFor(timezone) {
  if (!partCache.has(timezone)) {
    partCache.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', weekday: 'short',
    }));
  }
  return partCache.get(timezone);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date, timezone) {
  const parts = {};
  for (const p of formatterFor(timezone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
  };
}

// Convert a wall-clock time in `timezone` to a UTC Date using the offset in
// effect at midday of that wall-clock day.
function zonedToUtc(y, m, d, hour, minute, timezone) {
  const middayUtc = Date.UTC(y, m - 1, d, 12, 0);
  const p = zonedParts(new Date(middayUtc), timezone);
  const offsetMinutes = (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - middayUtc) / 60000;
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - offsetMinutes * 60000);
}

function dayMatches(cron, parts) {
  if (!cron.month.has(parts.month)) return false;
  const domOk = cron.dom.has(parts.day);
  const dowOk = cron.dow.has(parts.weekday);
  // POSIX rule: when both fields are restricted, either may match.
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

export function upcomingRuns(expression, timezone, from = new Date(), count = 3) {
  const cron = parseCron(expression);
  const hours = [...cron.hour].sort((a, b) => a - b);
  const minutes = [...cron.minute].sort((a, b) => a - b);
  const results = [];
  const start = new Date(Math.ceil((from.getTime() + 1) / 60000) * 60000);
  const p0 = zonedParts(start, timezone);
  // Walk successive *local calendar days*, each probed at local midday.
  // A fixed 24h UTC step would skip the 23-hour spring-forward day (and
  // double-probe the fall-back day); calendar-day arithmetic anchored away
  // from midnight is immune to both. Date.UTC rolls day overflow forward.
  for (let dayOffset = 0; dayOffset < 400 && results.length < count; dayOffset++) {
    const probe = zonedToUtc(p0.year, p0.month, p0.day + dayOffset, 12, 0, timezone);
    const parts = zonedParts(probe, timezone);
    if (!dayMatches(cron, parts)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const fire = zonedToUtc(parts.year, parts.month, parts.day, h, m, timezone);
        if (fire >= start) {
          results.push(fire);
          if (results.length >= count) return results;
        }
      }
    }
  }
  return results;
}

export function nextRun(expression, timezone, from = new Date()) {
  return upcomingRuns(expression, timezone, from, 1)[0] ?? null;
}

export function validateCron(expression) {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return err.message;
  }
}
