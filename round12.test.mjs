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
