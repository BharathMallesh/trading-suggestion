// Tests for the RSI swing (oversold bounce) strategy.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r43-'));
process.env.RSI_SWING_PATH = join(TMP, 'rsi.json');
process.env.RSI_SWING_PAPER_PATH = join(TMP, 'rsi-paper.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const r = await import('./paper-bot/rsi-swing.mjs');

test('Wilder RSI: falls toward 0 in a steady decline, rises toward 100 in a steady rise', () => {
  const down = r.rsiSeries(Array.from({ length: 40 }, (_, i) => 100 - i));
  assert.equal(down[13], null);
  assert.ok(down[39] < 5);
  const up = r.rsiSeries(Array.from({ length: 40 }, (_, i) => 100 + i));
  assert.ok(up[39] > 95);
});

// a stock that falls for weeks (daily and hourly RSI very low), then bounces
function build() {
  const daily = [];
  const hourly = [];
  let px = 1000;
  const hours = ['09:15', '10:15', '11:15', '12:15', '13:15', '14:15', '15:15'];
  for (let k = 0; k < 40; k++) {
    const d = new Date(Date.UTC(2026, 0, 1) + k * 86400000).toISOString().slice(0, 10);
    const dayOpen = px;
    const falling = k < 30;
    const bars = hours.map((h, j) => {
      const o = px;
      // falling: every hour red; day 30: red candles, then a green candle that closes above the last red high
      let c = falling ? px * 0.995 : k === 30 ? (j < 3 ? px * 0.997 : px * 1.006) : px * 1.002;
      const bar = { date: `${d} ${h}`, open: o, high: Math.max(o, c) * 1.0005, low: Math.min(o, c) * 0.9995, close: c };
      px = c;
      return bar;
    });
    hourly.push(...bars);
    daily.push({ date: d, open: dayOpen, high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)), close: px });
  }
  return { daily, hourly };
}

test('a buy after both RSI conditions and an hourly green close above the last red high; stop at the day low', () => {
  const { daily, hourly } = build();
  const t = r.tradesFor('X.NS', hourly, daily, { version: 'b' });
  assert.ok(t.length >= 1);
  const first = t[0];
  assert.equal(first.side, 'long');
  assert.ok(first.dailyRsi < 30 && first.hourlyRsi < 25);
  assert.ok(first.stop < first.entry);
  assert.equal(first.entryDate.slice(0, 10) >= '2026-01-31', true, 'enters on the bounce day or later');
  const s = r.summarise(t);
  assert.equal(s.trades, t.filter((x) => !x.open).length);
});

test('the three exit versions and the short mirror run on the same data', () => {
  const { daily, hourly } = build();
  for (const v of ['a', 'b', 'c']) assert.ok(Array.isArray(r.tradesFor('X.NS', hourly, daily, { version: v })));
  assert.ok(Array.isArray(r.tradesFor('X.NS', hourly, daily, { side: 'short' })));
});

test('improvement candidates: trend filter and the bounce exit', () => {
  assert.deepEqual(Object.keys(r.IMPROVEMENTS), ['base', 'trend', 'market', 'bounce', 'trendBounce', 'trendBounce10', 'all']);
  const { daily, hourly } = build();
  // the synthetic stock is far below its 200-day average (too short a history) → the trend filter blocks every buy
  assert.equal(r.tradesFor('X.NS', hourly, daily, { version: 'd', trend: true }).length, 0);
  // a market filter that always says no blocks every buy
  assert.equal(r.tradesFor('X.NS', hourly, daily, { version: 'b', market: () => false }).length, 0);
  const bounce = r.tradesFor('X.NS', hourly, daily, { version: 'd' });
  assert.ok(bounce.every((t) => ['bounce', 'stop', 'open'].includes(t.reason) || /days/.test(t.reason)));
});
