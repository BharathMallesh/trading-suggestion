// Tests for the calendar study (paper-bot/calendar-study.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const cs = await import('./paper-bot/calendar-study.mjs');

// trading days of Jan–Mar 2024 except a Friday holiday (26 Jan) and a Monday holiday (25 Mar)
const days = [];
for (let t = Date.parse('2024-01-01T00:00:00Z'); t <= Date.parse('2024-03-29T00:00:00Z'); t += 86400000) {
  const d = new Date(t).toISOString().slice(0, 10);
  const w = new Date(t).getUTCDay();
  if (w >= 1 && w <= 5 && d !== '2024-01-26' && d !== '2024-03-25') days.push(d);
}
const cal = cs.buildCalendar(days);

test('holidays come from missing weekdays: the day before and the day after', () => {
  assert.equal(cal.info.get('2024-01-25').holiday, 'day before a holiday');
  assert.equal(cal.info.get('2024-01-29').holiday, 'day after a holiday', 'Monday after the Friday holiday');
  assert.equal(cal.info.get('2024-03-22').holiday, 'day before a holiday', 'Friday before the Monday holiday');
  assert.equal(cal.info.get('2024-01-24').holiday, 'other days');
  assert.equal(cal.info.get('2024-03-29').holiday, 'other days', 'the end of the data is not a holiday');
});

test('trading day of the month from the start and the end, and the part of the month', () => {
  assert.equal(cal.info.get('2024-01-01').fromStart, 1);
  assert.equal(cal.info.get('2024-01-31').fromEnd, -1);
  assert.equal(cal.info.get('2024-01-31').turn, -1);
  assert.equal(cal.info.get('2024-02-01').turn, 1);
  assert.equal(cal.info.get('2024-02-01').phase, 'start (days 1–5)');
  assert.equal(cal.info.get('2024-02-12').phase, 'middle (days 6–15)');
  assert.equal(cal.info.get('2024-02-12').turn, null);
  assert.equal(cal.info.get('2024-02-29').phase, 'end (day 16 → last)');
});

test('cuts: values grouped by month / part of month / holiday, with 2008–16 and 2017 → halves', () => {
  const rows = days.map((d) => ({ d, v: cal.info.get(d).holiday === 'day before a holiday' ? 1 : 0.1 }));
  const c = cs.cuts(rows, cal);
  assert.equal(c.holiday['day before a holiday'].all.avg, 1);
  assert.ok(Math.abs(c.holiday['other days'].all.avg - 0.1) < 1e-9);
  assert.equal(c.month.Jan.all.n, cal.months.get('2024-01').length);
  assert.equal(c.month.Jan.early.n, 0, 'all in 2017 →');
  assert.equal(c.weekday.Mon.all.n > 0, true);
});

test('monthly returns and the turn-of-month rule', () => {
  const closes = days.map((d, i) => ({ date: d, close: 100 + i }));
  const m = cs.monthlyReturns(closes);
  assert.equal(m.length, 2);
  assert.equal(m[0].month, 'Feb');
  const r = cs.turnOfMonthRule(closes, cal, { cost: 0, cashYield: 0 });
  assert.equal(r.all.months, 2);
  assert.ok(r.all.avg4day > 0 && r.all.buyHoldPerYear > 0);
});
