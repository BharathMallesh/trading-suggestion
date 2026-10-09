// Tests for option payoff odds, the FII positioning parser/features, the
// Ling replay (anonymisation + verdict) and the llmAdjust switch. Offline.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-p2-'));
process.env.FII_DIR = join(TMP, 'fii');
process.env.SETTINGS_PATH = join(TMP, 'settings.json');
process.env.CALIBRATION_PATH = join(TMP, 'calibration.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const { probAboveNormal, probAboveHistory, optionOdds } = await import('./paper-bot/option-odds.mjs');
const { parseParticipantCsv, fiiFeatures, participantOi } = await import('./paper-bot/fii.mjs');
const { anonymise, lingReplay } = await import('./paper-bot/ling-replay.mjs');
const { saveSettings, resetSettings, validate } = await import('./paper-bot/settings.mjs');
const { lingAdjust } = await import('./paper-bot/groww-predict.mjs');
const { PAPER } = await import('./paper-bot/config.mjs');

const day = (i) => new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10);

test('normal odds: ~50% at the median, symmetric, and more vol widens the tails', () => {
  const s = 0.01;
  const median = 100 * Math.exp(-(s * s * 5) / 2);
  assert.ok(Math.abs(probAboveNormal(100, median, s, 5) - 0.5) < 1e-9);
  assert.ok(probAboveNormal(100, 105, 0.02, 5) > probAboveNormal(100, 105, 0.01, 5));
  assert.equal(probAboveNormal(100, 0, 0.01, 5), 1);
});

test('history odds rescale past moves to the forecast vol', () => {
  let x = 3;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const r = Array.from({ length: 600 }, () => (rnd() - 0.5) * 0.04);
  const pLow = probAboveHistory(100, 103, 0.005, 5, r);
  const pHigh = probAboveHistory(100, 103, 0.03, 5, r);
  assert.ok(pHigh > pLow, `${pHigh} vs ${pLow}`);
  assert.equal(probAboveHistory(100, 103, 0.01, 5, r.slice(0, 20)), null);
});

test('optionOdds: breakeven, profit odds, fair value vs premium, validation', async () => {
  const rows = Array.from({ length: 800 }, (_, i) => ({ date: day(i), close: 100 * Math.exp(0.01 * Math.sin(i)) }));
  const vol = async () => ({ symbol: 'X.NS', forecastPct: 20, impliedPct: 30, model: 'har', eventPending: false });
  const o = await optionOdds({ symbol: 'X.NS', type: 'CE', strike: 102, premium: 1, days: 7, loadCandles: async () => rows, vol });
  assert.equal(o.breakeven, 103);
  assert.ok(o.probProfit.forecastNormal > 0 && o.probProfit.forecastNormal < 0.5);
  assert.ok(o.probProfit.impliedNormal > o.probProfit.forecastNormal, 'higher implied vol → higher odds');
  const pe = await optionOdds({ symbol: 'X.NS', type: 'PE', strike: 98, days: 7, loadCandles: async () => rows, vol });
  assert.equal(pe.breakeven, 98 - pe.premium);
  assert.match(pe.premiumSource, /implied vol 30/);
  assert.equal(pe.premiumVsFairPct, null, 'synthesized premium vs fair is circular');
  assert.match(pe.reading, /estimated from implied volatility/);
  assert.ok(o.premiumVsFairPct != null, 'user-entered premium is compared');
  await assert.rejects(() => optionOdds({ symbol: 'X.NS', type: 'XX', strike: 1, vol }), /CE or PE/);
  await assert.rejects(() => optionOdds({ symbol: 'X.NS', type: 'CE', strike: 0, vol }), /strike/);
});

test('FII: parse NSE participant OI (comma or tab) and build features', () => {
  const csv = '"Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Oct 07, 2026",,,\n' +
    'Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short\t,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short\n' +
    'Client,100,200,1,1,10,20,30,40\nFII,25,75,1,1,40,10,20,30\nTOTAL,1,1,1,1,1,1,1,1\n';
  const p = parseParticipantCsv(csv);
  assert.deepEqual(p.FII, { futLong: 25, futShort: 75, callLong: 40, putLong: 10, callShort: 20, putShort: 30 });
  assert.equal(parseParticipantCsv('garbage'), null);
  const series = Array.from({ length: 70 }, (_, i) => ({ date: day(i), fii: { futLong: 20 + i, futShort: 80, callLong: 1, callShort: 1, putLong: 1, putShort: 1 } }));
  const f = fiiFeatures(series);
  assert.ok(Math.abs(f[0].longRatio - 0.2) < 1e-9);
  assert.equal(f[10].longRatioZ, null); // needs 40 days of history
  assert.ok(f[69].longRatioZ > 1, 'rising long ratio → positive z');
  assert.ok(f[69].ratioChg5 > 0);
});

test('FII: only a 404 is cached as "no data"; blocks throw and are never cached', async () => {
  assert.equal(await participantOi('2026-10-04', { fetchFn: async () => ({ ok: false, status: 404 }) }), null);
  assert.equal(await participantOi('2026-10-04', { fetchFn: async () => assert.fail('cached') }), null);
  assert.equal(await participantOi('2026-10-05', { fetchFn: async () => { throw new Error('offline'); } }), null);
  await assert.rejects(() => participantOi('2026-10-06', { fetchFn: async () => ({ ok: false, status: 403 }) }), /blocking/);
  await assert.rejects(() => participantOi('2026-10-06', { fetchFn: async () => ({ ok: true, status: 200, text: async () => '<H1>Access Denied</H1>' }) }), /blocking/);
  let called = false;
  await participantOi('2026-10-06', { fetchFn: async () => { called = true; return { ok: false, status: 404 }; } });
  assert.equal(called, true, 'a block was not cached');
});

test('Ling replay anonymises (no real dates / prices / names) and applies the fixed verdict rule', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ date: day(i), open: 1500 + i, high: 1510 + i, low: 1490 + i, close: 1500 + i + (i % 3), volume: 1000 }));
  const a = anonymise(rows.slice(0, 80));
  assert.equal(a[a.length - 1].date, 'D-0');
  assert.equal(a[a.length - 1].close, 100);
  assert.ok(!/\d{4}-\d\d-\d\d/.test(JSON.stringify(a)));
  const seen = [];
  const helpful = async ({ meta, rows: w, base }) => {
    seen.push({ meta, sample: JSON.stringify(w) });
    // nudge toward UP (the synthetic series trends up)
    return { prediction: { probUp: base.probUp + 0.1, probDown: Math.max(0.02, base.probDown - 0.1), probSideways: base.probSideways, adjustmentNote: 'tilted up' }, llmError: null };
  };
  const r = await lingReplay({ n: 30, symbols: ['A.NS', 'B.NS'], loadCandles: async () => rows, adjust: helpful, concurrency: 2 });
  assert.equal(r.adjusted, 30);
  assert.ok(seen.every((s) => s.meta.symbol === 'STOCK' && !/\d{4}-\d\d-\d\d/.test(s.sample)), 'no real dates reach Ling');
  assert.ok(['helps', 'inconclusive', 'hurts'].includes(r.verdict));
  assert.ok(Number.isFinite(r.tStat));
});

test("Settings llmAdjust switches Ling's adjustment off (base probabilities returned)", async () => {
  assert.throws(() => validate({ llmAdjust: 'maybe' }), /true or false/);
  saveSettings({ llmAdjust: false });
  assert.equal(PAPER.llmAdjust, false);
  const base = { probUp: 0.25, probDown: 0.25, probSideways: 0.5 };
  const { prediction } = await lingAdjust({ meta: { symbol: 'X' }, rows: [], ind: {}, base, score: 0, horizons: [] });
  assert.equal(prediction.probUp, 0.25);
  assert.match(prediction.summary, /switched off/);
  resetSettings();
  assert.equal(PAPER.llmAdjust, true);
});
