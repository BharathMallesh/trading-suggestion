// Tests for Momentum 10 + buffer (the idea-search candidate).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r45-'));
process.env.MOMENTUM10_PATH = join(TMP, 'm10.json');
process.env.MOMENTUM10_PAPER_PATH = join(TMP, 'm10-paper.json');
process.env.NSE_ETF_PATH = join(TMP, 'etfs.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const m = await import('./paper-bot/momentum10.mjs');
const { priceIndex } = await import('./paper-bot/momentum.mjs');

const R = (syms) => syms.map((symbol, i) => ({ symbol, rank: i + 1, score: -i }));

test('buffer: holdings still in the top 40 are kept, the rest of the 10 slots fill from the top', () => {
  const ranked = R(Array.from({ length: 50 }, (_, i) => `S${i + 1}`));
  const fresh = m.bufferPick(ranked, new Set());
  assert.deepEqual(fresh.map((x) => x.symbol), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']);
  const held = new Set(['S35', 'S45', 'S2']); // S35 kept (inside 40), S45 dropped (outside 40)
  const out = m.bufferPick(ranked, held).map((x) => x.symbol);
  assert.equal(out.length, 10);
  assert.ok(out.includes('S35') && out.includes('S2') && !out.includes('S45'));
  assert.deepEqual(out.slice(2), ['S1', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
});

test('residual momentum: a stock that only follows NIFTY scores about zero; one that beats it daily scores high', () => {
  const dates = [];
  for (let t = Date.UTC(2020, 0, 1); dates.length < 320; t += 86400000) if (new Date(t).getUTCDay() % 6) dates.push(new Date(t).toISOString().slice(0, 10));
  const nifty = dates.map((d, i) => 100 * Math.exp(0.01 * Math.sin(i) + 0.0003 * i));
  const nClose = new Map(dates.map((d, i) => [d, nifty[i]]));
  const follower = { dates, close: nifty.map((x) => x * 2), open: nifty };
  const leader = { dates, close: nifty.map((x, i) => x * Math.exp(0.002 * i + 0.003 * Math.cos(i * 1.7))), open: nifty };
  const me = dates.at(-1);
  const f = m.features(follower, me, nClose);
  const l = m.features(leader, me, nClose);
  assert.ok(Math.abs(f.resMom) < 0.5, `follower ${f.resMom}`);
  assert.ok(l.resMom > 3, `leader ${l.resMom}`);
  const idx = priceIndex(new Map([['FOL', dates.map((date, i) => ({ date, open: follower.close[i], close: follower.close[i] }))], ['LEAD', dates.map((date, i) => ({ date, open: leader.close[i], close: leader.close[i] }))]]));
  assert.equal(m.rankBy(nClose)(idx, ['FOL', 'LEAD'], me)[0].symbol, 'LEAD');
});

test('paper: waits for the first month-end, then buys 10; next month keeps buffered names and sells the rest at cost', async () => {
  const opens = { A: 100, B: 200, C: 50 };
  const loadCandles = async (sym, o) => {
    const s = sym.replace('.NS', '');
    const px = opens[s] ?? 10;
    if (o.range) return [{ date: '2026-12-10', close: px * 1.1, open: px }];
    return [{ date: '2026-11-02', open: px, close: px }, { date: '2026-12-01', open: px * 1.2, close: px * 1.2 }].filter((r) => Date.parse(r.date) / 1000 > o.period1);
  };
  const ten = (first) => R([first, ...Array.from({ length: 45 }, (_, i) => `X${i}`)]);
  // before the start month's end: nothing bought
  let st = await m.momentum10PaperUpdate({ loadCandles, now: new Date('2026-10-30T10:00:00Z'), ranked: { monthEnd: '2026-09-30', ranked: ten('A'), preview: { date: '2026-10-29', ranked: ten('A') } } });
  assert.equal(st.rebalances.length, 0);
  st = await m.momentum10PaperUpdate({ loadCandles, now: new Date('2026-11-02T12:00:00Z'), ranked: { monthEnd: '2026-10-30', ranked: ten('A'), preview: { date: '2026-11-02', ranked: ten('A') } } });
  assert.equal(st.rebalances.length, 1);
  assert.equal(st.rebalances[0].holdings.length, 10);
  assert.ok(st.rebalances[0].holdings.every((h) => !h.kept));
  // next month A falls to rank 30 (kept by the buffer), X8 falls out of the top 40 (sold), B is new at the top
  const ranked = R(['B', ...Array.from({ length: 28 }, (_, i) => `X${i === 8 ? 99 : i}`), 'A', ...Array.from({ length: 15 }, (_, i) => `Y${i}`), 'X8']);
  st = await m.momentum10PaperUpdate({ loadCandles, now: new Date('2026-12-01T12:00:00Z'), ranked: { monthEnd: '2026-11-30', ranked, preview: { date: '2026-12-01', ranked } } });
  const last = st.rebalances.at(-1);
  assert.equal(st.rebalances.length, 2);
  assert.ok(last.holdings.find((h) => h.symbol === 'A').kept);
  assert.deepEqual(last.sold, ['X8']);
  assert.deepEqual(last.bought, ['B']);
  assert.ok(last.value > 100000 * 1.1, 'gains carried across the change');
});
