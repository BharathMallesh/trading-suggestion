// Tests for the Up/Down outlook (labels, odds tables, scorecard).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r54-'));
process.env.UPDOWN_TABLE_PATH = join(TMP, 't.json');
process.env.UPDOWN_LIVE_PATH = join(TMP, 'l.json');
process.env.NSE_ETF_PATH = join(TMP, 'etfs.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const ud = await import('./paper-bot/updown-outlook.mjs');

test('features: 200-day average, 12-1 momentum, 52-week high and RSI use data up to the bar only', () => {
  const up = Array.from({ length: 300 }, (_, i) => 100 + i);
  const f = ud.features(up, 299);
  assert.equal(f.above200, true);
  assert.ok(Math.abs(f.mom - (up[278] / up[47] - 1)) < 1e-12);
  assert.equal(f.hi52, 1);
  assert.equal(f.rsi, 100);
  assert.equal(ud.features(up, 200), null, 'needs a year of history');
  const changed = [...up.slice(0, 280), ...Array(20).fill(1)]; // later bars must not affect bar 279
  assert.deepEqual(ud.features(changed, 279), ud.features(up, 279));
});

test('labels: strong needs top-20% momentum, above the 200-day and near the high; weak = bottom 20% and below', () => {
  assert.equal(ud.labelOf({ above200: true, hi52: 0.95 }, 0.85), 'strong');
  assert.equal(ud.labelOf({ above200: true, hi52: 0.85 }, 0.85), 'neutral');
  assert.equal(ud.labelOf({ above200: false, hi52: 0.5 }, 0.1), 'weak');
  assert.equal(ud.labelOf({ above200: true, hi52: 0.5 }, 0.1), 'neutral');
  assert.equal(ud.percentile([1, 2, 3, 4], 3.5), 0.75); // another stock: share of the list below it
  assert.equal(ud.percentile([1, 2, 3, 4], 4, { member: true }), 1); // the best of the list itself
});

// two stocks for 400 days: WIN keeps rising, LOSE keeps falling; NIFTY flat
const days = [];
for (let t = Date.UTC(2009, 0, 1); days.length < 420; t += 86400000) if (new Date(t).getUTCDay() % 6) days.push(new Date(t).toISOString().slice(0, 10));
const mk = (f) => days.map((date, i) => ({ date, open: f(i), high: f(i), low: f(i), close: f(i) }));
const series = new Map([['WIN', mk((i) => 100 * 1.003 ** i)], ['LOSE', mk((i) => 100 * 0.997 ** i)], ['MID', mk((i) => 100 + Math.sin(i / 9))]]);
const uni = new Map(days.map((d) => [d.slice(0, 7), new Set(['WIN', 'LOSE', 'MID'])]));
const nifty = days.map((date) => ({ date, close: 100 }));

test('odds table: the rising stock is labelled strong and its later moves are counted under strong', () => {
  const t = ud.buildTable(series, uni, nifty);
  assert.ok(t.samples > 0);
  assert.ok(t.labels.strong.all['1m'].n > 0 && t.labels.strong.all['1m'].up === 1);
  assert.ok(t.labels.weak.all['1m'].up === 0);
  assert.equal(t.labels.strong.all['1m'].beatsNifty, 1);
});

test("snapshot + scorecard: today's labels, and saved lists graded once the horizon has passed", () => {
  const snap = ud.snapshot(series, uni);
  assert.equal(snap.rows.find((x) => x.symbol === 'WIN').label, 'strong');
  assert.equal(snap.rows.find((x) => x.symbol === 'LOSE').label, 'weak');
  const past = days[days.length - 30];
  const sc = ud.scorecard([{ date: past, strong: [{ symbol: 'WIN' }], weak: [{ symbol: 'LOSE' }] }], series);
  assert.equal(sc.strong['1m'].up, 1);
  assert.equal(sc.weak['1m'].up, 0);
  assert.equal(sc.strong['3m'].n, 0, 'three months have not passed yet');
});
