// Tests: the Up / Down / Sideways scoring band matches the prediction's horizon (daily ATR for next-session calls).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r56-'));
process.env.PREDICTION_LOG_PATH = join(TMP, 'pred.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const pl = await import('./paper-bot/prediction-log.mjs');

const result = (mode, intervalMinutes) => ({ symbol: 'ABC.NS', mode, intervalMinutes, lastClose: 1000, prediction: { bias: 'SIDEWAYS', probUp: 0.25, probDown: 0.25, probSideways: 0.5 }, indicators: { atr14: 3 }, expectedMove: { atr: 20 } });

test('a next-session call logs the daily ATR; a 1-hour call logs the 15-minute ATR', () => {
  const s = pl.logPrediction(result('multi', 15));
  const h = pl.logPrediction(result('15m', 15));
  const log = JSON.parse(readFileSync(process.env.PREDICTION_LOG_PATH, 'utf8'));
  const es = log.entries.find((e) => e.id === (s.id || s));
  const eh = log.entries.find((e) => e.id === (h.id || h));
  assert.equal(es.atr, 20);
  assert.equal(es.atrBasis, 'daily');
  assert.equal(eh.atr, 3);
  assert.equal(eh.atrBasis, 'bars');
});

test('daily ATR uses only sessions before the call', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, high: 102, low: 98, close: 100 });
  rows.push({ date: '2026-10-21', high: 200, low: 50, close: 100 }); // the call's own day must not count
  assert.equal(pl.dailyAtrBefore(rows, '2026-10-21'), 4);
});

test('re-scoring an old session call with the daily ATR turns a +0.5% move from UP into SIDEWAYS', async () => {
  const day = (i) => `2026-10-${String(i).padStart(2, '0')}`;
  const rows = Array.from({ length: 20 }, (_, i) => ({ date: day(i + 1), high: 1010, low: 990, close: 1000 }));
  writeFileSync(process.env.PREDICTION_LOG_PATH, JSON.stringify({ entries: [{ id: 'x', ts: '2026-10-21T05:00:00Z', symbol: 'ABC.NS', mode: 'multi', intervalMinutes: 15, lastClose: 1000, bias: 'SIDEWAYS', probUp: 0.25, probDown: 0.25, probSideways: 0.5, atr: 3, evaluated: true, realizedRetPct: 0.5, realizedLabel: 'UP', evalThresholdPct: 0.15 }] }));
  const r = await pl.rescoreSessionEntries({ loadCandles: async () => rows });
  assert.equal(r.rescored, 1);
  const e = JSON.parse(readFileSync(process.env.PREDICTION_LOG_PATH, 'utf8')).entries[0];
  assert.equal(e.realizedLabel, 'SIDEWAYS'); // band = 0.35 × 2% = 0.7%
  assert.equal(e.realizedLabelOld, 'UP');
  assert.equal(e.hitBias, true);
  assert.equal((await pl.rescoreSessionEntries({ loadCandles: async () => rows })).rescored, 0, 'only once');
});
