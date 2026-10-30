// Tests for the Steady mix (30% Momentum 10 with filter / 10% gold / 60% liquid).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r46-'));
process.env.STEADY_MIX_PATH = join(TMP, 'sm.json');
process.env.STEADY_MIX_PAPER_PATH = join(TMP, 'sm-paper.json');
process.env.MOMENTUM10_PAPER_PATH = join(TMP, 'm10-paper.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const sm = await import('./paper-bot/steady-mix.mjs');

test('mix returns: 30 / 10 / 60 of stocks, gold and the liquid fund, less the re-balance drag', () => {
  const rs = sm.mixReturns(['2020-01'], { stocks: new Map([['2020-01', 0.1]]), gold: new Map([['2020-01', -0.05]]) });
  const cash = 1.06 ** (1 / 12) - 1;
  assert.ok(Math.abs(rs[0].r - (0.3 * 0.1 + 0.1 * -0.05 + 0.6 * cash - 0.0005)) < 1e-12);
});

test('stats: worst fall, months up and positive 12-month stretches', () => {
  const rs = Array.from({ length: 24 }, (_, i) => ({ m: `20${10 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, r: i === 3 ? -0.1 : 0.01 }));
  const s = sm.stats(rs);
  assert.ok(Math.abs(s.maxDrawdown - 0.1) < 1e-9);
  assert.equal(s.upMonths, 23 / 24);
  assert.equal(s.worstMonth, -0.1);
  assert.ok(s.pos12 > 0.5 && s.pos12 <= 1);
});

// NIFTY rising for a year then dropping well below its 200-day average
const days = [];
for (let t = Date.UTC(2025, 0, 1); days.length < 330; t += 86400000) if (new Date(t).getUTCDay() % 6) days.push(new Date(t).toISOString().slice(0, 10));
const up = (n) => days.slice(0, n).map((date, i) => ({ date, open: 100 + i, close: 100 + i }));
const crash = days.map((date, i) => ({ date, open: i < 260 ? 100 + i : 360 - (i - 260) * 3, close: i < 260 ? 100 + i : 360 - (i - 260) * 3 }));

test('market filter replays the band: IN while NIFTY rises, OUT after it falls below its 200-day average', () => {
  assert.equal(sm.filterAt(up(330), days[300]), true);
  assert.equal(sm.filterAt(crash, days[329]), false);
});

test('paper: OUT puts the stock part in the liquid fund; IN buys the Momentum 10 list with 30%', async () => {
  const last = (nifty, monthEnd) => {
    const loadCandles = async (sym, o) => {
      if (sym === '^NSEI') return nifty;
      const px = sym.startsWith('GOLD') ? 50 : 100;
      if (o.range) return [{ date: nifty.at(-1).date, open: px, close: px * 1.02 }];
      return nifty.filter((r) => Date.parse(r.date) / 1000 > o.period1).map((r) => ({ date: r.date, open: px, close: px }));
    };
    return loadCandles;
  };
  // month-end inside the crash: filter OUT
  const outNifty = crash;
  const ends = [...new Set(outNifty.map((x) => x.date.slice(0, 7)))];
  const me = outNifty.filter((x) => x.date.slice(0, 7) === ends.at(-2)).at(-1).date;
  let st = await sm.steadyMixPaperUpdate({ loadCandles: last(outNifty, me), now: new Date(`${days[0]}T10:00:00Z`), m10: { monthEnd: me, list: [{ symbol: 'AAA' }, { symbol: 'BBB' }] } });
  const r0 = st.rebalances[0];
  assert.equal(r0.inMarket, false);
  assert.ok(r0.holdings.every((h) => h.kind !== 'stock'));
  assert.ok(Math.abs(r0.holdings.reduce((a, h) => a + h.amount, 0) - 100000) < 1e-6);
  assert.equal(r0.holdings.find((h) => h.kind === 'gold').amount, 10000);
  // a fresh account in a rising market: filter IN, the Momentum 10 list is bought with 30%
  rmSync(process.env.STEADY_MIX_PAPER_PATH, { force: true });
  const inNifty = up(330);
  const me2 = inNifty.filter((x) => x.date.slice(0, 7) === [...new Set(inNifty.map((x) => x.date.slice(0, 7)))].at(-2)).at(-1).date;
  st = await sm.steadyMixPaperUpdate({ loadCandles: last(inNifty, me2), now: new Date(`${days[0]}T10:00:00Z`), m10: { monthEnd: me2, list: [{ symbol: 'AAA' }, { symbol: 'BBB' }] } });
  const stocks = st.rebalances[0].holdings.filter((h) => h.kind === 'stock');
  assert.equal(st.rebalances[0].inMarket, true);
  assert.deepEqual(stocks.map((h) => h.name), ['AAA', 'BBB']);
  assert.equal(stocks[0].amount, 15000);
  assert.ok(st.curve.at(-1).value > 100000, 'stocks and gold up 2% at the close');
});
