// Tests for the "which stocks to invest in?" research agent (facts and screens, never picks).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const r = await import('./paper-bot/invest-research.mjs');
const a = await import('./paper-bot/assistant.mjs');

const move = (ratio) => async () => ({ horizons: { '5d': { odds: [{ movePct: 4, prob: 0.2 * ratio, pastYear: 0.2 }] } } });
const deps = (triggered, strong, ratio = 1) => ({
  scanFn: async () => ({ triggered, strong }),
  moveFn: move(ratio),
  brakeFn: async () => ({ state: 'in', reading: 'NIFTY 4% above its 200-day average' }),
  fundsFn: async () => ({ categories: { n50: { label: 'NIFTY 50', funds: [{ name: 'Fund A', type: 'ETF', r3: 0.12, gap3: 0 }, { name: 'Fund B', type: 'Index fund', r3: 0.119, gap3: -0.001 }] } } }),
  newsFn: async () => ({ headlines: [{ title: 'Company wins order' }] }),
  sizing: { capital: 200000, riskPct: 1 },
  compare: () => ({ rows: [{ key: 'ath', backtest: '+0.16 R without survivorship bias' }] }),
});

test('invest questions route to the research agent; others keep their answers', () => {
  for (const q of ['which stocks to invest', 'which is the best stock to invest today?', 'what should i buy', 'best stocks']) assert.equal(a.detectIntent(q, null), 'invest', q);
  assert.equal(a.detectIntent('which index fund?', null), 'funds');
  assert.equal(a.detectIntent('NIFTY call put this week', null), 'options');
  assert.equal(a.detectIntent('tell me about reliance', 'RELIANCE.NS'), 'stock');
  assert.equal(a.detectIntent("today's results", null), 'results');
});

test('sizing: risk ≤ 1% of capital and the position ≤ capital', () => {
  assert.deepEqual(r.sizeFor(100, 95, { capital: 100000, riskPct: 1 }), { qty: 200, value: 20000, riskRs: 1000 });
  assert.equal(r.sizeFor(1000, 999, { capital: 100000, riskPct: 1 }).qty, 100, 'capped by capital');
  assert.equal(r.sizeFor(100, 101, { capital: 100000, riskPct: 1 }), null);
});

test('with swing signals: index funds first, then the screen with stop, sizing and risk; no buy wording', async () => {
  const out = await r.investResearch(deps(
    [{ symbol: 'LT.NS', setup: 'flag breakout', close: 3500, stop: 3325, riskPct: 5 }, { symbol: 'HDFCBANK.NS', setup: 'base', close: 700, stop: 670, riskPct: 4.3, held: true }],
    [{ symbol: 'TCS.NS', close: 3000, fromAthPct: 2, weeklyRsi: 60 }],
    2,
  ));
  assert.equal(out.intent, 'invest');
  assert.match(out.sections[0].heading, /index funds/);
  const screen = out.sections.find((s) => /swing rules today/.test(s.heading));
  assert.equal(screen.rows.length, 1, 'already-held stock is not listed as new');
  assert.equal(screen.rows[0][0], 'LT');
  assert.match(screen.rows[0][5], /^11 /, '₹2,000 risk / ₹175 per share = 11 shares');
  assert.ok(out.summary.some((x) => /already held on paper: HDFCBANK/.test(x)));
  assert.ok(out.summary.some((x) => /Be careful with LT, TCS/.test(x)), 'twice the usual chance of a 4% week');
  const text = JSON.stringify(out).toLowerCase();
  assert.ok(!/\b(buy now|strong buy|you should buy|will go up|target price)\b/.test(text), 'facts and screens only');
  assert.match(out.caveat, /not advice/);
});

test('no signals and a failed scan are handled', async () => {
  const none = await r.investResearch(deps([], [{ symbol: 'TCS.NS', close: 3000, fromAthPct: 2, weeklyRsi: 60 }]));
  assert.ok(none.summary.some((x) => /No stock met the strong-stock swing rules/.test(x)));
  assert.ok(none.sections.some((s) => /Strong stocks to watch/.test(s.heading)));
  const fail = await r.investResearch({ ...deps([], []), scanFn: async () => { throw new Error('Yahoo down'); } });
  assert.ok(fail.sections.some((s) => /unavailable/.test(s.heading)));
});
