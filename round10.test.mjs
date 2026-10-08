// Tests for: big-move odds (tails, climatology, calibration, live shape), the
// HAR short-horizon fix, the options-positioning signals and test, and the
// vol-model merge. Offline, temp files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r10-'));
process.env.BIG_MOVE_PATH = join(TMP, 'big-move.json');
process.env.FO_POS_DIR = join(TMP, 'pos');
process.env.FO_POS_RESULT = join(TMP, 'pos.json');
process.env.VOL_MODEL_PATH = join(TMP, 'vol-model.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const bm = await import('./paper-bot/big-move.mjs');
const op = await import('./paper-bot/options-positioning.mjs');
const { harForecast, saveVolModel, updateVolModel } = await import('./paper-bot/volatility.mjs');
const { greeks } = await import('./blackscholes.mjs');

let seed = 5;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const day = (i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);

test('HAR one-day forecast is in line with the true vol (no log-normal blow-up)', () => {
  const r = Array.from({ length: 1000 }, () => gauss() * 0.01);
  for (const h of [1, 5, 21]) {
    const f = harForecast(r, h);
    assert.ok(f > 0.008 && f < 0.012, `h=${h}: ${f}`);
  }
});

test('tail odds: normal sample gives normal-like tails; bigger σ → bigger odds', () => {
  const z = Array.from({ length: 5000 }, gauss);
  const p = bm.tailProb(z, 0.01, 1, 1); // 1σ move
  assert.ok(Math.abs(p.both - 0.317) < 0.03, `${p.both}`);
  assert.ok(Math.abs(p.up - p.down) < 0.03);
  assert.ok(bm.tailProb(z, 0.02, 1, 2).both > bm.tailProb(z, 0.01, 1, 2).both);
  assert.ok(Math.abs(bm.normalTail(0.01, 1, 1) - 0.317) < 0.01);
});

test('climatology counts past moves only, with a small prior', () => {
  const closes = Array.from({ length: 300 }, (_, i) => 100 * (i % 2 ? 1.03 : 1)); // ±3% every day
  const c = bm.climatology(closes, 299, 1, 2);
  assert.ok(c > 0.95);
  assert.ok(bm.climatology(closes, 299, 1, 5) < 0.01);
});

test('calibration: σ scale lowers odds, blending moves them toward the past-year rate', () => {
  const z = Array.from({ length: 2000 }, gauss);
  const raw = bm.calibrated(z, 0.01, 1, 1, 0.1, { scale: 1, shrink: 0 }).both;
  const scaled = bm.calibrated(z, 0.01, 1, 1, 0.1, { scale: 0.9, shrink: 0 }).both;
  const blended = bm.calibrated(z, 0.01, 1, 1, 0.1, { scale: 1, shrink: 0.5 }).both;
  assert.ok(scaled < raw);
  assert.ok(Math.abs(blended - (raw + 0.1) / 2) < 1e-12);
});

test('bigMove: odds for both horizons, rising with volatility, using the saved calibration', async () => {
  const mk = (vol) => {
    let p = 1000;
    return Array.from({ length: 800 }, (_, i) => ({ date: day(i), close: (p *= Math.exp(gauss() * vol)) }));
  };
  const calm = mk(0.005);
  const wild = mk(0.03);
  const a = await bm.bigMove({ symbol: 'A.NS', loadCandles: async () => calm });
  const b = await bm.bigMove({ symbol: 'B.NS', loadCandles: async () => wild });
  assert.ok(b.horizons['1d'].odds[0].prob > a.horizons['1d'].odds[0].prob);
  assert.deepEqual(a.horizons['5d'].odds.map((o) => o.movePct), bm.THRESHOLDS[5]);
  const ev = await bm.bigMove({ symbol: 'A.NS', loadCandles: async () => calm, eventPending: true });
  assert.ok(ev.horizons['1d'].sigmaPct > a.horizons['1d'].sigmaPct, 'results due widens σ');
  writeFileSync(process.env.BIG_MOVE_PATH, JSON.stringify({ at: 'x', horizons: { '1d': { verdict: 'skill', calibration: { scale: 0.5, shrink: 0 } }, '5d': { verdict: 'no clear skill' } } }));
  const c = await bm.bigMove({ symbol: 'A.NS', loadCandles: async () => calm });
  assert.ok(c.horizons['1d'].odds[0].prob < a.horizons['1d'].odds[0].prob, 'scale applied');
  assert.equal(c.horizons['1d'].validated, true);
  await assert.rejects(() => bm.bigMove({ symbol: 'X', loadCandles: async () => calm.slice(0, 100) }), /history/);
});

// ------------------------------------------------------ options positioning

test('implied vol inverts Black-Scholes', () => {
  const price = greeks({ spot: 100, strike: 97, tYears: 7 / 365, iv: 0.18, type: 'PE' }).price;
  assert.ok(Math.abs(op.impliedVol({ price, spot: 100, strike: 97, tYears: 7 / 365, type: 'PE' }) - 0.18) < 1e-6);
  assert.equal(op.impliedVol({ price: 0, spot: 100, strike: 97, tYears: 0.02, type: 'PE' }), null);
});

test('day features: PCR, net OI change and skew from a parsed bhavcopy', () => {
  const t = 7 / 365;
  const px = (k, type, iv) => greeks({ spot: 20000, strike: k, tYears: t, iv, type }).price;
  const row = (k) => ({
    CE: px(k, 'CE', k > 20000 ? 0.12 : 0.15), PE: px(k, 'PE', k < 20000 ? 0.18 : 0.15),
    ceVol: 10, peVol: 20, ceOi: 100, peOi: 150, ceDoi: 10, peDoi: 30,
  });
  const parsed = { underlying: 20000, expiries: { '2026-10-15': Object.fromEntries([19400, 20000, 20600].map((k) => [k, row(k)])) } };
  const f = op.dayFeatures(parsed, 20000, '2026-10-08');
  assert.equal(f.pcrOi, 1.5);
  assert.equal(f.pcrVol, 2);
  assert.ok(Math.abs(f.netDoi - (90 - 30) / 750) < 1e-12);
  assert.ok(Math.abs(f.skew - 6) < 0.01, `skew ${f.skew}`); // 18% put vs 12% call
  assert.ok(Math.abs(f.atmIv - 15) < 0.01);
});

test('z-scores use only the past; evaluation finds a planted signal and passes the strict bar', () => {
  const n = 900;
  const nifty = [];
  let p = 10000;
  const series = [];
  for (let i = 0; i < n + 6; i++) {
    const sig = gauss();
    series.push({ date: day(i), pcrOi: 1 + 0.1 * sig, pcrVol: 1 + 0.1 * gauss(), netDoi: 0.01 * gauss(), skew: 3 + gauss() });
    nifty.push({ date: day(i), close: p });
    // tomorrow's return follows today's PCR (planted)
    p *= 1 + 0.006 * sig + 0.003 * gauss();
  }
  const withZ = op.withZ(series, 'pcrOi', 'pcrOiZ');
  assert.equal(withZ[10].pcrOiZ, null, 'needs 40 days first');
  const full = op.withZ(op.withZ(series, 'pcrOi', 'pcrOiZ'), 'skew', 'skewZ');
  const r = op.evaluate(full, nifty);
  assert.equal(r['1d'].features.pcrOi.evidence, 'strong');
  assert.notEqual(r['1d'].features.pcrVol.evidence, 'strong');
});

test('positioning day cache: holiday cached as null, network trouble not cached', async () => {
  const notFound = async () => ({ ok: false, status: 404 });
  assert.equal(await op.positioningDay('2024-01-26', 21000, { fetchFn: notFound }), null);
  assert.equal(readFileSync(join(process.env.FO_POS_DIR, '2024-01-26.json'), 'utf8'), 'null');
  const down = async () => {
    throw new Error('offline');
  };
  assert.equal(await op.positioningDay('2024-01-29', 21000, { fetchFn: down }), undefined);
});

test('vol-model save keeps fields maintained by other jobs', () => {
  updateVolModel({ niftyWeeklyIvToVix: { recentMedian: 0.9 } });
  saveVolModel({ horizon: 5, summary: { har: { meanQlike: 1 } }, niftyHeadToHead: { blend: { meanQlike: 1 } }, niftyImpliedVsRealised: null });
  const m = JSON.parse(readFileSync(process.env.VOL_MODEL_PATH, 'utf8'));
  assert.equal(m.niftyWeeklyIvToVix.recentMedian, 0.9);
  assert.equal(m.bestStock, 'har');
});

test('robustness: a real next-morning signal survives; a reversal artifact does not', () => {
  const n = 1200;
  const nifty = [];
  const real = [];
  const fake = [];
  let p = 10000;
  let today = 0;
  for (let i = 0; i < n; i++) {
    const sig = gauss();
    const open = p * (1 + 0.002 * gauss());
    // real: tomorrow's open→close follows today's signal
    const close = open * (1 + 0.004 * sig + 0.006 * gauss());
    nifty.push({ date: day(i), open, close });
    real.push({ date: day(i - 1), s: sig });
    p = close;
  }
  const r1 = op.robustness(real.slice(1), nifty, 's');
  assert.match(r1.verdict, /^survives/);
  // artifact: the "signal" is just today's move, and moves partly reverse overnight
  const nifty2 = [];
  p = 10000;
  for (let i = 0; i < n; i++) {
    const open = p * (1 - 0.5 * today + 0.001 * gauss());
    const close = open * (1 + 0.008 * gauss());
    nifty2.push({ date: day(i), open, close });
    fake.push({ date: day(i), s: -(close / p - 1) + 0.001 * gauss() });
    today = close / p - 1;
    p = close;
  }
  const r2 = op.robustness(fake, nifty2, 's');
  assert.match(r2.verdict, /does not survive/);
});
