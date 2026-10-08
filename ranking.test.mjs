// Tests for the cross-sectional ranking replay (paper-bot/ranking.mjs). Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { spearman, evaluateRanking, liveRanking, SIGNALS } = await import('./paper-bot/ranking.mjs');

/** Synthetic universe: daily closes with per-stock drift (persistent or noise). */
function universe(nStocks, nDays, { persistent }) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const start = Date.parse('2021-01-01');
  const out = {};
  for (let s = 0; s < nStocks; s++) {
    const drift = persistent ? (s - nStocks / 2) * 0.0004 : 0; // strong, persistent winners/losers
    let c = 100;
    const rows = [];
    for (let d = 0; d < nDays; d++) {
      c *= 1 + drift + (rnd() - 0.5) * 0.02;
      const date = new Date(start + d * 86400000).toISOString().slice(0, 10);
      rows.push({ date, open: c, high: c, low: c, close: c });
    }
    out[`S${s}.NS`] = rows;
  }
  return out;
}

test('spearman: perfect, inverse, and tied ranks', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.ok(Math.abs(spearman([1, 1, 2, 3], [1, 2, 3, 4]) - 0.9487) < 1e-3);
});

test('signals use only the past: 12-1 momentum skips the latest month', () => {
  const c = Array.from({ length: 300 }, (_, i) => 100 + i);
  const before = SIGNALS.mom12_1(c);
  c[c.length - 1] = 9999; // last bar is inside the skipped month
  assert.equal(SIGNALS.mom12_1(c), before);
});

test('replay finds strong evidence when winners keep winning', async () => {
  const data = universe(20, 900, { persistent: true });
  const r = await evaluateRanking({ horizon: 20, symbols: Object.keys(data), loadCandles: async (s) => { if (!data[s]) throw new Error('n/a'); return data[s]; } });
  assert.equal(r.summary.mom12_1.evidence, 'strong');
  assert.ok(r.summary.mom12_1.meanIC > 0.3);
  assert.ok(r.summary.mom12_1.topNCagrPct > r.benchmark.equalWeightCagrPct);
});

test('replay finds no strong evidence on pure noise', async () => {
  const data = universe(20, 900, { persistent: false });
  const r = await evaluateRanking({ horizon: 20, symbols: Object.keys(data), loadCandles: async (s) => { if (!data[s]) throw new Error('n/a'); return data[s]; } });
  for (const [k, v] of Object.entries(r.summary)) assert.notEqual(v.evidence, 'strong', `${k} looked strong on noise`);
});

test('ranking validates horizon and needs enough stocks; live ranking orders by composite', async () => {
  await assert.rejects(() => evaluateRanking({ horizon: 7 }), /horizon/);
  const small = universe(4, 900, { persistent: true });
  await assert.rejects(() => evaluateRanking({ symbols: Object.keys(small), loadCandles: async (s) => small[s] }), /at least 10/);
  const data = universe(12, 400, { persistent: true });
  const live = await liveRanking({ symbols: Object.keys(data), loadCandles: async (s) => data[s] });
  assert.equal(live.ranking.length, 12);
  for (let i = 1; i < live.ranking.length; i++) assert.ok(live.ranking[i - 1].composite >= live.ranking[i].composite);
});
