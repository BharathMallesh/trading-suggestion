// Tests for the spread paper tracker (₹10,000 practice account).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r58-'));
process.env.SPREAD_PAPER_PATH = join(TMP, 'sp.json');
process.env.FO_BHAV_DIR = join(TMP, 'fo');
process.env.FO_STOCKS_DIR = join(TMP, 'fo-stocks');
process.env.BHAV_EQ_DIR = join(TMP, 'eq');
after(() => rmSync(TMP, { recursive: true, force: true }));
const sp = await import('./paper-bot/spread-paper.mjs');
const { legCharges } = await import('./paper-bot/fo-riskcheck.mjs');

// a 100 / 60 put spread on a ₹100 stock, lot 100: bought at ₹30, sold at ₹30 − cost/100 (net cost = `cost`)
const row = (symbol, chance, cost, extra = {}) => ({ symbol, lean: 'weak', kind: 'spread', strategy: 'put-spread', chanceOfProfit: chance, cost, maxLoss: cost + 50, maxProfit: 40 * 100 - cost, lot: 100, expiry: '2026-11-24', spot: 100,
  date: '2026-11-04', sessions: 13, minVolume: 500,
  legs: [{ strike: 100, type: 'PE', side: 'buy', price: 30 }, { strike: 60, type: 'PE', side: 'sell', price: 30 - cost / 100 }], ...extra });
const call = (symbol, chance, cost) => row(symbol, chance, cost, { lean: 'strong', strategy: 'call-spread', legs: [{ strike: 100, type: 'CE', side: 'buy', price: 30 }, { strike: 140, type: 'CE', side: 'sell', price: 30 - cost / 100 }] });
const pick = async () => ({ date: '2026-11-04', rows: [
  row('FFF', 0.9, 1000, { date: '2026-11-03' }), // yesterday's prices: never traded on
  row('GGG', 0.8, 1000, { sessions: 3 }), // too close to expiry
  row('DDD', 0.7, 1000, { minVolume: 20 }), // a leg barely traded
  row('AAA', 0.5, 2500), row('BBB', 0.45, 2000), row('CCC', 0.4, 2800), // CCC: a third put — too many the same way
  call('EEE', 0.3, 1000), { ...row('ZZZ', 0.95, 900), kind: 'option' },
] });
const none = async () => ({ date: null, rows: [] });
const quiet = { fetchDay: async () => null, eqClose: () => null, loadCandles: async () => [], dayCheck: async () => null };
const EVENING = new Date('2026-11-04T15:00:00Z'); // 20:30 IST on a trading day

test('opens only on the day\'s own closes: best odds first, max 2 the same way, liquid legs, ≥ 5 sessions; charges count at once', async () => {
  let { st, opened } = await sp.spreadPaperUpdate({ now: EVENING, pick, ...quiet });
  assert.equal(opened, 3);
  assert.deepEqual(st.trades.map((t) => t.symbol), ['AAA', 'BBB', 'EEE']);
  assert.equal(st.cash, 10000 - 2500 - 2000 - 1000);
  assert.equal(st.trades[0].maxLoss, 2550, 'the most-you-can-lose (with charges) is kept');
  assert.equal(st.trades[0].exitBy, '2026-11-20', 'a stock spread is sold 2 sessions before expiry');
  assert.ok(st.trades.every((t) => t.entryCharges > 0 && t.mark === -t.entryCharges));
  assert.ok(st.summary.value < 10000, `the account is worth less than ₹10,000 the moment charges are paid: ${st.summary.value}`);
  ({ st, opened } = await sp.spreadPaperUpdate({ now: new Date('2026-11-04T16:00:00Z'), pick, ...quiet }));
  assert.equal(opened, 0, 'same entry day: nothing new');
});

test('nothing opens while the market is open, or on an older day\'s prices', async () => {
  process.env.SPREAD_PAPER_PATH = join(TMP, 'sp-open.json');
  try {
    let { opened } = await sp.spreadPaperUpdate({ now: new Date('2026-11-05T05:00:00Z'), pick, ...quiet }); // 10:30 IST
    assert.equal(opened, 0);
    ({ opened } = await sp.spreadPaperUpdate({ now: new Date('2026-11-05T11:00:00Z'), pick, ...quiet })); // 16:30 IST, but the rows are 11-04's
    assert.equal(opened, 0);
  } finally {
    process.env.SPREAD_PAPER_PATH = join(TMP, 'sp.json');
  }
});

test('cash is kept for every open trade\'s full worst case, so it can never go below zero', async () => {
  process.env.SPREAD_PAPER_PATH = join(TMP, 'sp-cash.json');
  try {
    const two = async () => ({ rows: [call('AAA', 0.5, 2940), { ...row('BBB', 0.4, 2940), maxLoss: 3048.6 }].map((x) => ({ ...x, maxLoss: 3048.6 })) });
    const { st, opened } = await sp.spreadPaperUpdate({ now: EVENING, pick: two, rules: { capital: 6000, perTrade: 3100 }, ...quiet });
    assert.equal(opened, 1, 'the second trade\'s worst case does not fit what is left');
    assert.ok(st.cash - (st.trades[0].maxLoss - st.trades[0].cost) >= 0);
  } finally {
    process.env.SPREAD_PAPER_PATH = join(TMP, 'sp.json');
  }
});

test('a stock spread is sold at the option closes 2 sessions before expiry, after entry and exit charges', async () => {
  mkdirSync(process.env.FO_STOCKS_DIR, { recursive: true });
  writeFileSync(join(process.env.FO_STOCKS_DIR, '2026-11-20.json'), JSON.stringify({ AAA: { underlying: 58, lot: 100, expiries: { '2026-11-24': { 100: { PE: 41 }, 60: { PE: 1.5 } } } } }));
  const { st } = await sp.spreadPaperUpdate({ now: new Date('2026-11-20T15:00:00Z'), pick: none, ...quiet });
  const a = st.trades.find((t) => t.symbol === 'AAA');
  assert.equal(a.open, false);
  assert.equal(a.settleHow, 'sold before expiry');
  const exit = (legCharges(41, -1, '2026-11-20', { lot: 100 }) + legCharges(1.5, 1, '2026-11-20', { lot: 100 })) * 100;
  assert.ok(Math.abs(a.pnl - ((41 - 1.5) * 100 - 2500 - a.entryCharges - exit)) < 1e-6, `${a.pnl}`);
  assert.ok(st.trades.filter((t) => t.symbol !== 'AAA').every((t) => t.open), 'no saved prices for the others yet');
});

test('a pick that fails does not lose the settlements of the same run', async () => {
  process.env.SPREAD_PAPER_PATH = join(TMP, 'sp-fail.json');
  try {
    await sp.spreadPaperUpdate({ now: EVENING, pick, ...quiet });
    writeFileSync(join(process.env.FO_STOCKS_DIR, '2026-11-20.json'), JSON.stringify({ AAA: { underlying: 58, lot: 100, expiries: { '2026-11-24': { 100: { PE: 41 }, 60: { PE: 1.5 } } } } }));
    const { st } = await sp.spreadPaperUpdate({ now: new Date('2026-11-20T15:00:00Z'), pick: async () => { throw new Error('Yahoo down'); }, ...quiet });
    assert.equal(st.trades.find((t) => t.symbol === 'AAA').open, false);
    assert.equal(sp.loadSpreadPaper().trades.find((t) => t.symbol === 'AAA').open, false, 'saved');
  } finally {
    process.env.SPREAD_PAPER_PATH = join(TMP, 'sp.json');
  }
});

test('held to expiry: settles only after the expiry close, from NSE\'s own price first; flags one with no price after 3 sessions', async () => {
  // BBB and EEE had no saved option prices before expiry: they fall back to the expiry close
  const intraday = async () => [{ date: '2026-11-24', close: 85 }];
  let { st } = await sp.spreadPaperUpdate({ now: new Date('2026-11-24T06:00:00Z'), pick: none, ...quiet, loadCandles: intraday }); // 11:30 IST
  assert.ok(st.trades.filter((t) => t.symbol !== 'AAA').every((t) => t.open));
  writeFileSync(join(process.env.FO_STOCKS_DIR, '2026-11-24.json'), JSON.stringify({ BBB: { underlying: 55, lot: 100, expiries: {} } }));
  ({ st } = await sp.spreadPaperUpdate({ now: new Date('2026-11-24T11:00:00Z'), pick: none, ...quiet, loadCandles: async (y) => (y === 'BBB.NS' ? [{ date: '2026-11-24', close: 999 }] : []) }));
  const b = st.trades.find((t) => t.symbol === 'BBB');
  assert.equal(b.open, false);
  assert.equal(b.settlePrice, 55, 'NSE\'s price, not Yahoo\'s');
  assert.ok(b.pnl < 40 * 100 - 2000 && b.pnl > 40 * 100 - 2000 - 300, `about width − cost, less charges: ${b.pnl}`);
  const e = st.trades.find((t) => t.symbol === 'EEE');
  assert.ok(e.open && !e.unsettled, 'no price yet, but only just expired');
  ({ st } = await sp.spreadPaperUpdate({ now: new Date('2026-11-27T15:00:00Z'), pick: none, ...quiet }));
  assert.ok(st.trades.find((t) => t.symbol === 'EEE').unsettled, 'flagged after 3 sessions without a price');
  assert.equal(st.summary.unsettled, 1);
  const closed = st.trades.filter((t) => !t.open);
  const open = st.trades.filter((t) => t.open);
  assert.ok(Math.abs(st.cash - (10000 + closed.reduce((x, t) => x + t.pnl, 0) - open.reduce((x, t) => x + t.cost, 0))) < 1e-6, 'cost and result returned to cash');
});

test('Budget 2026 STT: 0.15% on option sales and on exercise from 1 Apr 2026 (0.1% / 0.125% before)', async () => {
  const { sttSell, sttExercise } = await import('./paper-bot/fo-strangle.mjs');
  assert.equal(sttSell('2026-03-31'), 0.1);
  assert.equal(sttSell('2026-04-01'), 0.15);
  assert.equal(sttExercise('2026-03-31'), 0.125);
  assert.equal(sttExercise('2026-04-01'), 0.15);
  const { payoff } = await import('./paper-bot/fo-riskcheck.mjs');
  const legs = [{ k: 100, t: 'CE', q: 1, p: 5 }];
  const diff = payoff(legs, 200, '2026-03-31', { lot: 100 }) - payoff(legs, 200, '2026-04-01', { lot: 100 });
  assert.ok(Math.abs(diff - 100 * 0.00025) < 1e-9, 'exercise STT on ₹100 of intrinsic rises by 0.025%');
});

test('stock chains keep each expiry\'s own lot (NSE lot revisions)', async () => {
  const { parseStockChains } = await import('./paper-bot/vol-premium.mjs');
  const head = 'TckrSymb,FinInstrmTp,XpryDt,StrkPric,OptnTp,ClsPric,TtlTradgVol,UndrlygPric,NewBrdLotQty';
  const csv = [head, 'XYZ,STO,2026-11-24,100,CE,5,10,100,500', 'XYZ,STO,2026-12-29,100,CE,7,10,100,400'].join('\n');
  const o = parseStockChains(csv, '2026-11-04').XYZ;
  assert.deepEqual(o.lots, { '2026-11-24': 500, '2026-12-29': 400 });
  assert.equal(o.lot, 500, 'the nearest expiry\'s lot');
});
