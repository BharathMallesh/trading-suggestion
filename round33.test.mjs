// Tests for the F&O spreads from the specification document (momentum-debit, ivrank-credit).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r33-'));
process.env.FNO_SPREADS_PATH = join(TMP, 'fno-spreads.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const f = await import('./paper-bot/fno-spreads.mjs');
const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const series = (n, px) => Array.from({ length: n }, (_, i) => { const c = px(i); return { date: day(i), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 + (i % 7) * 100 }; });

test('indicators: SMA, Wilder RSI, realised vol, IV = vol × 1.08, IV rank 0–100', () => {
  const b = f.indicators(series(200, (i) => 1000 * (1 + 0.003 * Math.sin(i / 3)) * (1 + i / 2000)));
  const x = b[199];
  assert.ok(x.sma20 > 0 && x.sma50 > 0);
  assert.ok(x.rsi > 0 && x.rsi < 100);
  assert.ok(Math.abs(x.iv - x.rv * 1.08) < 1e-12);
  assert.ok(x.ivRank >= 0 && x.ivRank <= 100);
  assert.equal(b[50].ivRank, null, 'needs 60 volatility readings');
});

test('signals follow the document: momentum long, credit direction by RSI and the 5-day guard', () => {
  const base = { close: 110, sma20: 105, sma50: 100, rsi: 62, volRatio: 1.3, ret5: 2, ret20: 5, rv: 0.2, iv: 0.216, ivRank: 70, atr: 2 };
  assert.equal(f.debitSignal(base).type, 'call');
  assert.equal(f.debitSignal({ ...base, rsi: 75 }), null, 'RSI above 72');
  assert.equal(f.debitSignal({ ...base, volRatio: 1 }), null, 'volume too low');
  assert.equal(f.debitSignal({ ...base, close: 90, sma20: 95, sma50: 100, rsi: 35, ret5: -2, ret20: -5 }).type, 'put');
  assert.equal(f.creditSignal({ ...base, rsi: 35, ret5: -1 }).type, 'put');
  assert.equal(f.creditSignal({ ...base, rsi: 35, ret5: -3 }), null, 'no puts after a 5-day fall beyond 2.5%');
  assert.equal(f.creditSignal({ ...base, rsi: 65, ret5: 1 }).type, 'call');
  assert.equal(f.creditSignal({ ...base, rsi: 50 }), null, 'middle RSI needs IV rank ≥ 75');
  assert.equal(f.creditSignal({ ...base, rsi: 48, ivRank: 80, ret5: 0 }).type, 'put');
  assert.equal(f.creditSignal({ ...base, rsi: 35, iv: 0.15 }), null, 'IV below 18%');
});

test('positions: strikes, debit/credit checks, sizing by max loss, whole lots', () => {
  const b = { date: day(0), close: 1000, iv: 0.3, atr: 20 };
  const p = f.buildPosition({ kind: 'debit', type: 'call', strategy: 'momentum-debit', side: 'bull call debit spread' }, b, 'X.NS', 100000, { dte: 12 });
  assert.equal(p.longStrike, 1000);
  assert.equal(p.shortStrike, 1020, '2 strike steps of 10');
  assert.ok(p.entryPrice > 0.7 && p.entryPrice <= 0.6 * p.width);
  assert.equal(p.qty, Math.floor(1250 / p.maxLoss));
  const c = f.buildPosition({ kind: 'credit', type: 'put', strategy: 'ivrank-credit', side: 'put credit spread' }, b, 'X.NS', 100000, { dte: 10 });
  assert.equal(c.shortStrike, 980, 'about 1 ATR below');
  assert.ok(c.longStrike < c.shortStrike);
  assert.ok(Math.abs(c.maxLoss - (c.width - c.entryPrice)) < 1e-9);
  const lot = f.buildPosition({ kind: 'debit', type: 'call', strategy: 'momentum-debit', side: 'x' }, b, 'X.NS', 100000, { dte: 12, lot: 500 });
  assert.ok(lot.skip && /one lot/.test(lot.skip), '₹1 lakh cannot hold a 500-share lot at 1.25% risk');
  assert.equal(f.strikeStep(400), 5);
  assert.equal(f.strikeStep(4000), 50);
});

test('monthly expiries: last Thursday, last Tuesday from September 2025', () => {
  assert.equal(f.monthlyExpiry(2024, 10), '2024-10-31');
  assert.equal(f.monthlyExpiry(2026, 10), '2026-10-27');
});

test('simulation: walks forward, max 3 open, exits by target / stop / time or at expiry', () => {
  const up = f.indicators(series(400, (i) => 500 * 1.004 ** i * (1 + 0.02 * Math.sin(i / 5))));
  const flat = f.indicators(series(400, (i) => 800 * (1 + 0.05 * Math.sin(i / 4))));
  const data = [{ symbol: 'A.NS', bars: up }, { symbol: 'B.NS', bars: flat }];
  for (const s of ['momentum-debit', 'ivrank-credit']) {
    const sim = f.simulate(data, s, { from: day(120) });
    for (const t of sim.trades) {
      assert.ok(['target', 'stop', 'time', 'end of test'].includes(t.reason));
      assert.ok(t.costs > 0);
      assert.ok(t.entryDate >= day(120), 'no trades before the start');
    }
    const sum = f.summarise(sim);
    assert.equal(sum.trades, sim.trades.length);
    const held = f.simulate(data, s, { from: day(120), holdToExpiry: true });
    for (const t of held.trades) assert.ok(['expiry', 'end of test'].includes(t.reason));
  }
});
