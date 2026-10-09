// Tests for the investor-assistant features: broker tradebook import (CSV,
// dates, FIFO replay, booked gains), portfolio + crash-brake alerts with
// notification-friendly texts, the crash-brake reading, and the SIP /
// lump-sum expectations maths. Offline, temp files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r12-'));
process.env.HOLDINGS_PATH = join(TMP, 'holdings.json');
process.env.MONITOR_DIR = join(TMP, 'monitor');
after(() => rmSync(TMP, { recursive: true, force: true }));

const h = await import('./paper-bot/holdings.mjs');
const { computeAlerts } = await import('./paper-bot/monitor.mjs');
const { crashBrake } = await import('./paper-bot/trend-history.mjs');
const ex = await import('./paper-bot/expectations.mjs');

test('CSV parser handles quotes, commas, CRLF and a BOM', () => {
  const rows = h.parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""",3\r\n\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'he said "hi"', '3']]);
});

test('broker date formats', () => {
  assert.equal(h.parseTradeDate('2024-03-05 10:11:12'), '2024-03-05');
  assert.equal(h.parseTradeDate('05-03-2024'), '2024-03-05');
  assert.equal(h.parseTradeDate('5/3/2024 10:12 AM'), '2024-03-05');
  assert.equal(h.parseTradeDate('08 Oct 2026, 10:12 AM'), '2026-10-08');
  assert.equal(h.parseTradeDate('8-Oct-2026'), '2026-10-08');
  assert.equal(h.parseTradeDate('garbage'), null);
});

test('tradebook parsing: Zerodha, Groww and generic; skips F&O, cancelled and bad rows', () => {
  const z = 'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price\nRELIANCE-EQ,X,2023-01-10,NSE,EQ,EQ,buy,false,10,2500.5\nNIFTY24OCTFUT,Y,2024-10-01,NSE,FO,,buy,false,50,100\nSBIN,Z,2024-01-01,BSE,EQ,EQ,buy,false,5,600\n';
  const a = h.parseTradebook(z);
  assert.deepEqual(a.trades.map((t) => t.symbol), ['RELIANCE.NS', 'SBIN.BO']);
  assert.equal(a.skipped.length, 1);
  const g = 'Stock name,Symbol,ISIN,Type,Quantity,Value,Exchange,Exchange Order Id,Execution date and time,Order status\nTCS,TCS,X,BUY,3,"10,500.00",NSE,1,08-01-2025 10:15 AM,Executed\nInfosys,INFY,Y,BUY,5,8000,NSE,2,09-01-2025 11:00 AM,Cancelled\n';
  const b = h.parseTradebook(g);
  assert.equal(b.trades.length, 1);
  assert.equal(b.trades[0].price, 3500, 'price from value ÷ quantity');
  assert.throws(() => h.parseTradebook('foo,bar\n1,2\n'), /header/);
});

test('import replays trades FIFO, books this year\'s gains, keeps the rest as lots', () => {
  const fyStart = (() => {
    const d = new Date(Date.now() + 19800_000);
    const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    return `${y}-04-15`;
  })();
  const csv = `symbol,trade_date,trade_type,quantity,price
A,2018-01-10,buy,10,100
A,2023-01-10,buy,5,200
A,${fyStart},sell,12,300
B,${fyStart},buy,4,50
C,${fyStart},sell,3,10
`;
  const r = h.importTradebook({ csv });
  assert.equal(r.trades, 5);
  // 10 old shares: +2,000 LT; 2 of the 2023 lot: +200 (held > 1 year → LT)
  assert.equal(r.realized.ltcg, 2200);
  assert.equal(r.realized.stcg, 0);
  assert.equal(r.warnings.length, 1, 'C sold without buys in the file');
  const lots = h.loadHoldings().lots.map((l) => [l.symbol, l.qty, l.price]);
  assert.deepEqual(lots.sort(), [['A.NS', 3, 200], ['B.NS', 4, 50]]);
  // merge mode keeps existing lots
  h.importTradebook({ csv: 'symbol,trade_date,trade_type,quantity,price\nD,2024-01-01,buy,1,10\n', mode: 'merge' });
  assert.equal(h.loadHoldings().lots.length, 3);
  assert.throws(() => h.importTradebook({ csv: 'x' }), /CSV/);
});

test('alerts: crash-brake state change, tax timing, risk spike, concentration', () => {
  const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const r = {
    crashBrake: { state: 'out', reading: 'NIFTY is 3% below its 200-day average.' },
    myPortfolio: {
      flags: ['X.NS is 40% of the portfolio (above 20%)'],
      soonLongTerm: [{ symbol: 'X.NS', qty: 5, longTermFrom: soon, taxSavedByWaiting: 2000 }],
      weeklyLossOdds: [{ lossPct: 5, prob: 0.12, pastYear: 0.02 }],
    },
  };
  const a = computeAlerts(r, { crashBrake: { state: 'in' } });
  assert.ok(a.some((x) => x.level === 'high' && /Crash brake/.test(x.text)));
  assert.ok(a.some((x) => /becomes long-term/.test(x.text)));
  assert.ok(a.some((x) => /losing more than 5%/.test(x.text)));
  assert.ok(a.some((x) => x.level === 'info' && /Concentration/.test(x.text)));
  // no state change → no crash-brake alert; small tax saving → no tax alert
  const b = computeAlerts({ ...r, myPortfolio: { ...r.myPortfolio, soonLongTerm: [{ ...r.myPortfolio.soonLongTerm[0], taxSavedByWaiting: 100 }] } }, { crashBrake: { state: 'out' } });
  assert.ok(!b.some((x) => /Crash brake/.test(x.text)));
  assert.ok(!b.some((x) => /becomes long-term/.test(x.text)));
});

test('crash brake reading with the ±1% band', async () => {
  const mk = (last) => Array.from({ length: 300 }, (_, i) => ({ date: `2025-${String(1 + Math.floor(i / 28) % 12).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, close: i === 299 ? last : 100 }));
  assert.equal((await crashBrake({ loadCandles: async () => mk(90) })).state, 'out');
  assert.equal((await crashBrake({ loadCandles: async () => mk(110) })).state, 'in');
  assert.equal((await crashBrake({ loadCandles: async () => mk(100.2) })).state, 'band');
});

test('expectations maths: XIRR and rolling windows on a steady 12% market', () => {
  // flows: invest 1 for 12 months at 12%/yr → irr ≈ 12%
  const flows = Array.from({ length: 12 }, () => -1);
  let v = 0;
  for (let k = 0; k < 12; k++) v += 1.12 ** ((12 - k) / 12);
  flows.push(v);
  assert.ok(Math.abs(ex.xirrMonthly(flows) - 0.12) < 1e-6);
  const monthly = Array.from({ length: 12 * 20 }, (_, i) => ({ month: `m${i}`, tr: 1.12 ** (i / 12) }));
  const o = ex.rollingOutcomes(monthly, 5);
  assert.ok(Math.abs(o.lumpSum.medianPct - 12) < 1e-6);
  assert.equal(o.lumpSum.pctWindowsLosing, 0);
  assert.ok(Math.abs(o.sip.medianPct - 12) < 1e-4);
  assert.equal(ex.rollingOutcomes(monthly.slice(0, 30), 5), null, 'not enough history');
});

test('direction-long: Newey–West regression, out-of-sample R², NSE file parsing', async () => {
  const dl = await import('./paper-bot/direction-long.mjs');
  let s = 11;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const x = Array.from({ length: 300 }, () => rnd());
  const yReal = x.map((v) => 2 * v + 0.3 * rnd());
  const fit = dl.olsNW(x, yReal, 3);
  assert.ok(Math.abs(fit.b - 2) < 0.1 && fit.t > 10);
  assert.ok(dl.r2OutOfSample(x, yReal, 1).r2os > 0.5, 'a real predictor beats the mean');
  const yNoise = x.map(() => rnd());
  assert.ok(dl.r2OutOfSample(x, yNoise, 1).r2os < 0.05, 'noise does not');
  process.env.INDEX_VAL_DIR = join(TMP, 'iv');
  const csv = 'Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield\nCNX Nifty,30-09-2014,1,1,1,7964.8,0,0,0,0,21.5,3.4,1.3\n';
  const v = await dl.niftyValuation('2014-09-30', { fetchFn: async () => ({ ok: true, status: 200, text: async () => csv }) });
  assert.deepEqual(v, { date: '2014-09-30', close: 7964.8, pe: 21.5, pb: 3.4, dy: 1.3 });
  assert.equal(await dl.niftyValuation('2014-10-02', { fetchFn: async () => ({ ok: false, status: 404 }) }), null);
  assert.equal(await dl.niftyValuation('2014-10-03', { fetchFn: async () => { throw new Error('offline'); } }), undefined);
});

test('intraday: softmax model learns a planted pattern', async () => {
  const it = await import('./paper-bot/intraday-test.mjs');
  let s = 5;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const X = [];
  const y = [];
  for (let i = 0; i < 600; i++) {
    const f = rnd() * 4;
    X.push([1, f]);
    y.push(f > 0.6 ? 0 : f < -0.6 ? 1 : 2);
  }
  const W = it.fitSoftmax(X, y, { iters: 400, lr: 1 });
  assert.ok(it.predictSoftmax(W, [1, 1.5]).probUp > 0.6);
  assert.ok(it.predictSoftmax(W, [1, -1.5]).probDown > 0.6);
  assert.ok(it.predictSoftmax(W, [1, 0]).probSideways > 0.5);
});

test('Groww: key + secret → daily token with SHA-256 checksum; refusals trip the breaker', async () => {
  process.env.GROWW_API_KEY = 'k';
  process.env.GROWW_API_SECRET = 's3cret';
  delete process.env.GROWW_ACCESS_TOKEN;
  const g = await import('./groww-data.mjs');
  const { createHash } = await import('node:crypto');
  let seen = null;
  const now = Date.parse('2026-10-09T05:00:00Z');
  const tok = await g.accessToken({ now, fetchFn: async (url, o) => {
    seen = { url, auth: o.headers.Authorization, body: JSON.parse(o.body) };
    return { ok: true, status: 200, json: async () => ({ token: 'TKN' }) };
  } });
  assert.equal(tok, 'TKN');
  assert.match(seen.url, /\/v1\/token\/api\/access$/);
  assert.equal(seen.auth, 'Bearer k');
  assert.equal(seen.body.key_type, 'approval');
  assert.equal(seen.body.checksum, createHash('sha256').update('s3cret' + seen.body.timestamp).digest('hex'));
  // cached until 06:00 IST: no second request
  assert.equal(await g.accessToken({ now: now + 3600000, fetchFn: async () => assert.fail('should be cached') }), 'TKN');
  g.resetAccessToken();
  await assert.rejects(() => g.accessToken({ now, fetchFn: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'nope' } }) }) }), /daily approval/);
  assert.equal(g.growwUsable(), true);
  delete process.env.GROWW_API_KEY;
  delete process.env.GROWW_API_SECRET;
  assert.equal(g.growwStatus().state, 'off');
});

test('Call/Put live scorecard: hits by lean, direction-only rate, too-early verdict', async () => {
  const { liveScorecard } = await import('./paper-bot/prediction-log.mjs');
  const mk = (pu, pd, ps, real, mode = '15m') => ({ evaluated: true, realizedLabel: real, probUp: pu, probDown: pd, probSideways: ps, mode, ts: '2026-10-09T05:00:00Z', symbol: 'X.NS', realizedRetPct: 0.1 });
  const entries = [mk(0.5, 0.3, 0.2, 'UP'), mk(0.5, 0.3, 0.2, 'DOWN'), mk(0.2, 0.5, 0.3, 'DOWN'), mk(0.2, 0.3, 0.5, 'SIDEWAYS', 'multi'), { evaluated: false, mode: '15m' }];
  const r = liveScorecard(entries);
  assert.equal(r.scored, 4);
  assert.equal(r.pending, 1);
  assert.equal(r.byLean.UP.calls, 2);
  assert.equal(r.byLean.UP.cameTrue, 0.5);
  assert.equal(r.byLean.DOWN.cameTrue, 1);
  assert.equal(r.directionCalls, 3);
  assert.ok(Math.abs(r.directionRight - 2 / 3) < 1e-9);
  assert.match(r.verdict, /Too early/);
  assert.equal(liveScorecard(entries, { mode: 'multi' }).scored, 1);
  assert.equal(r.recent.length, 4);
});

test('index funds: split adjustment snaps to standard ratios; scheme filters', async () => {
  const f = await import('./paper-bot/index-funds.mjs');
  const navs = [{ date: '2024-01-01', nav: 200 }, { date: '2024-01-02', nav: 202 }, { date: '2024-01-03', nav: 20.402 }, { date: '2024-01-04', nav: 20.5 }];
  const a = f.adjustSplits(navs);
  assert.ok(Math.abs(a[1].nav - 20.2) < 1e-9, '1:10 split → earlier NAVs ÷ 10 exactly');
  assert.ok(Math.abs(a[2].nav / a[1].nav - 1.01) < 1e-9, 'the split day keeps its real +1% move');
  assert.ok(f.matches('UTI Nifty 50 Index Fund - Direct Plan - Growth', 'nifty50'));
  assert.ok(f.matches('Nippon India ETF Nifty 50 BeES - Direct Plan', 'nifty50'));
  assert.ok(!f.matches('UTI Nifty 50 Index Fund - Regular Plan - Growth', 'nifty50'));
  assert.ok(!f.matches('NAVI ELSS TAX SAVER NIFTY50 INDEX FUND - Direct Plan - GROWTH', 'nifty50'));
  assert.ok(!f.matches('UTI Nifty Next 50 Index Fund - Direct Plan - Growth', 'nifty50'));
  assert.ok(f.matches('UTI - Nifty Next 50 Index Fund - Direct Plan - Growth', 'next50'));
  assert.ok(!f.matches('DSP BSE SENSEX Next 30 Index Fund - Direct Plan - Growth', 'sensex'));
});

test('goal planner on a steady 12% market', async () => {
  const ex = await import('./paper-bot/expectations.mjs');
  const monthly = Array.from({ length: 12 * 30 }, (_, i) => ({ month: `m${i}`, tr: 1.12 ** (i / 12) }));
  // ₹1/month for 10 years at 12% → about ₹231 at the end
  let fv = 0;
  for (let k = 0; k < 120; k++) fv += 1.12 ** ((120 - k) / 12);
  const g = ex.goalPlan(monthly, { target: fv * 10000, years: 10, sip: 10000 });
  assert.ok(Math.abs(g.sipNeeded.p50 - 10000) < 1e-3, 'steady market: every window needs the same SIP');
  assert.ok(Math.abs(g.sipNeeded.p100 - 10000) < 1e-3);
  assert.equal(g.withSip.successRate, 1);
  const lump = ex.goalPlan(monthly, { target: 1e6 * 1.12 ** 10, years: 10, lumpSum: 1e6 });
  assert.ok(lump.sipNeeded.p50 < 1e-6, 'the lump sum alone reaches the target');
  assert.equal(ex.goalPlan(monthly.slice(0, 50), { target: 1, years: 10 }), null);
});
