// Tests for "Ask the app" results questions: today / yesterday / week / month / a date.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const r = await import('./paper-bot/period-results.mjs');
const a = await import('./paper-bot/assistant.mjs');
const IST = (d, hm) => new Date(`${d}T${hm}:00+05:30`);

test('results questions are recognised (and others are not)', () => {
  for (const q of ["today's results", 'results', 'week results', 'last month p&l', 'how did the strategy do today?', 'results 23 oct', 'this month']) assert.equal(a.detectIntent(q, null), 'results', q);
  assert.equal(a.detectIntent('what will happen to TCS?', 'TCS.NS'), 'stock');
  assert.equal(a.detectIntent('which is the best stock to invest today?', null), 'invest');
  assert.equal(a.detectIntent('NIFTY call put this week', null), 'options');
});

test('periods: today before / after the evening run, yesterday, weeks, months, a date', () => {
  const tue = IST('2026-10-27', '10:00');
  assert.deepEqual([r.parsePeriod('today', tue).from, r.parsePeriod('today', tue).notYet], ['2026-10-26', '2026-10-27'], 'before 16:05: the latest recorded day');
  assert.equal(r.parsePeriod('today', IST('2026-10-27', '16:30')).from, '2026-10-27');
  assert.equal(r.parsePeriod('today', IST('2026-10-27', '15:55')).from, '2026-10-26', 'market closed but the evening run not yet done');
  assert.equal(r.parsePeriod('today', IST('2026-10-25', '12:00')).from, '2026-10-23', 'Sunday → Friday');
  assert.equal(r.parsePeriod('yesterday', tue).from, '2026-10-26');
  assert.deepEqual([r.parsePeriod('this week', tue).from, r.parsePeriod('this week', tue).to], ['2026-10-26', '2026-10-27']);
  assert.deepEqual([r.parsePeriod('last week', tue).from, r.parsePeriod('last week', tue).to], ['2026-10-19', '2026-10-25']);
  assert.deepEqual([r.parsePeriod('this month', tue).from, r.parsePeriod('last month', tue).from, r.parsePeriod('last month', tue).to], ['2026-10-01', '2026-09-01', '2026-09-30']);
  assert.equal(r.parsePeriod('results 23 oct', tue).from, '2026-10-23');
  assert.equal(r.parsePeriod('results 2026-10-15', tue).from, '2026-10-15');
  assert.equal(r.parsePeriod('yesterday', IST('2026-10-26', '10:00')).from, '2026-10-23', 'Monday → Friday');
});

test('period results: every strategy summed over the period, day by day, totals since start', () => {
  const papers = {
    vwap: { trades: [
      { variant: 'video', date: '2026-10-19', symbol: 'TRENT.NS', side: 'long', reason: 'stop', net: -1000 },
      { variant: 'video', date: '2026-10-21', symbol: 'TITAN.NS', side: 'long', reason: 'target', net: 1800 },
      { variant: 'scanner', date: '2026-10-21', symbol: 'TCS.NS', side: 'long', reason: 'stop', net: -1100 },
      { variant: 'video', date: '2026-10-27', symbol: 'MARUTI.NS', side: 'short', reason: 'target', net: 2000 },
    ] },
    breakfast: { trades: [{ date: '2026-10-19', symbol: 'TCS.NS', side: 'long', reason: 'stop', net: -5000 }] },
    swing: { trades: [{ version: 'original', symbol: 'M&M.NS', entryDate: '2026-10-19', exitDate: '2026-10-23', open: false, r: -1.05 }] },
    dip: null, fo: null, swingVersion: 'original',
  };
  const res = r.periodResults({ from: '2026-10-19', to: '2026-10-25', label: 'last week', kind: 'week' }, papers);
  const video = res.rows.find((x) => x.label.endsWith('video rules'));
  assert.equal(video.trades, 2);
  assert.equal(video.result, 800);
  assert.equal(video.total, 2800, 'since start includes later trades');
  assert.equal(res.totalRs, 800 - 1100 - 5000);
  assert.equal(res.rows.find((x) => x.unit === 'R').result, -1.05);
  assert.deepEqual(res.days.map((d) => d.date), ['2026-10-19', '2026-10-21', '2026-10-23']);
  const ans = r.resultsAnswer('last week results', { now: IST('2026-10-27', '10:00'), ...papers });
  assert.equal(ans.intent, 'results');
  assert.match(ans.title, /last week/);
  assert.ok(ans.sections.some((s) => s.heading === 'Day by day'));
  const none = r.resultsAnswer('results 25 oct', { now: IST('2026-10-27', '10:00'), ...papers });
  assert.match(none.summary[0], /NSE was closed/);
});
