// Tests for Finalist 2 (paper-bot/finalist2.mjs), the loop-22 algo-search finalist, PAPER ONLY:
//  • the score maths on synthetic data: median / sd / z-scores clipped at ±3, the four features (6- and 12-month
//    return ÷ vol, residual 12-1 momentum vs NIFTY, share of months beating NIFTY), the universe filters;
//  • the tranche schedule: both tranches filled on the first rebalance, then tranche 2 re-ranks on even rebalances,
//    tranche 1 on odd ones (an off-month tranche holds and only fills an empty slot);
//  • the keep-in-top-24 buffer, the "one real share costs more than the slot" skip (real, not split-adjusted, price),
//    the 5-point band, whole real shares;
//  • the paper walk on a temp BHAV_EQ_DIR with fake candles: nothing before the Nov 2026 month-end, the first buy
//    on 1 Dec 2026 fully invested, the next month's tranche 2 re-rank, save / restore across a split = one
//    continuous run, the Breakdown curve adapter; and the UI / server / run.sh wiring (not in Today's algo plan).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r76-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const BHAV = join(TMP, 'bhav-eq');
process.env.BHAV_EQ_DIR = BHAV;
process.env.FINALIST2_PAPER_PATH = join(TMP, 'finalist2-paper.json');
process.env.INDIA_MIX_PAPER_PATH = join(TMP, 'india-mix-paper.json');

const F2 = await import('./paper-bot/finalist2.mjs');
const { loadSeries } = await import('./paper-bot/bhav-history.mjs');

// ------------------------------------------------------------------ helpers ---
const weekdays = (from, to) => {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
/** A hand-made world: series Map(sym → rows) with constant prices unless `px(sym, i, d)` says otherwise. */
function makeWorld(syms, dates, { px = () => 100, raw = null, gold = () => 100, next50 = () => 100, nifty = () => 10000 } = {}) {
  const series = new Map(syms.map((s) => [s, dates.map((d, i) => {
    const c = px(s, i, d);
    return { date: d, open: c, close: c, val: 1e9 - syms.indexOf(s) * 1e6, rawClose: raw ? raw(s, i, d, c) : c };
  })]));
  const fund = (f) => ({ open: Float64Array.from(dates.map((d, i) => f(i))), close: Float64Array.from(dates.map((d, i) => f(i))) });
  return F2.buildWorld({ series, dates, niftyClose: dates.map((d, i) => nifty(i)), funds: { GOLD: fund(gold), NN50: fund(next50) }, symbols: syms, isStock: () => true });
}
const SYMS = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(2, '0')}`);
const stocks = (rec, part) => rec.holdings.filter((h) => h.kind === 'stock' && (!part || h.part === part)).map((h) => h.symbol).sort();
/** Run every session from the first entry on, with a fixed ranking per rebalance number. */
function runFixed(W, orders, opts = {}) {
  let k = 0;
  const a = new F2.Account(W, { ranker: (w) => (orders[k++] || orders.at(-1)).map((s) => w.si.get(s)), ...opts });
  const t0 = Math.min(...a.entries.keys());
  for (let t = t0; t < W.dates.length; t++) a.step(t);
  return a;
}

// -------------------------------------------------------------------- maths ---
test('median / sd / z-scores: numpy conventions, clipped at ±3, zero without spread', () => {
  assert.equal(F2.median([3, 1, 2]), 2);
  assert.equal(F2.median([4, 1, 3, 2]), 2.5); // mean of the two middle values (np.median), not the upper one
  assert.ok(Math.abs(F2.std([1, 2, 3, 4], 1) - Math.sqrt(5 / 3)) < 1e-12);
  assert.ok(Math.abs(F2.std([1, 2, 3, 4], 0) - Math.sqrt(5 / 4)) < 1e-12);
  const z = F2.zscores([...Array(20).fill(0), 100]);
  assert.equal(z.at(-1), 3); // a 4.5-sd outlier is clipped
  assert.ok(Math.abs(F2.zscores([1, 2, 3]).reduce((a, b) => a + b, 0)) < 1e-12);
  assert.deepEqual(F2.zscores([5, 5, 5]), [0, 0, 0]);
});

test('features on synthetic prices: returns, vol, residual momentum, months beating NIFTY', () => {
  const dates = weekdays('2024-01-01', '2025-06-30');
  seed = 11;
  const noise = dates.map(() => rnd() * 0.02);
  const own = dates.map(() => rnd() * 0.02);
  const W = makeWorld(['UP', 'FLAT'], dates, {
    // UP: its own noise and a 0.3%-a-day trend; FLAT: NIFTY's moves, lagging 0.05% a day
    px: (s, i) => (s === 'UP' ? 100 * Math.exp(0.003 * i + own[i]) : 100 * Math.exp(noise[i] * 0.5 - 0.0005 * i)),
    nifty: (i) => 10000 * Math.exp(noise[i] * 0.5),
  });
  const t = dates.length - 1;
  const up = F2.features(W, W.si.get('UP'), t);
  const C = W.S[W.si.get('UP')].C;
  assert.ok(Math.abs(up.r12 - (C[t] / C[t - 252] - 1)) < 1e-12);
  assert.ok(Math.abs(up.r6 - (C[t] / C[t - 126] - 1)) < 1e-12);
  assert.ok(Math.abs(up.r12v - up.r12 / up.vol) < 1e-12);
  assert.equal(up.nsm, 1); // a 0.3%-a-day trend beats a trendless NIFTY in each of the 12 months
  assert.ok(up.res > 3, `res ${up.res}`); // strong positive residual momentum
  assert.ok(Math.abs(up.beta) < 0.3); // its moves are its own
  const flat = F2.features(W, W.si.get('FLAT'), t);
  assert.ok(Math.abs(flat.beta - 1) < 1e-6); // FLAT moves with NIFTY
  assert.equal(flat.nsm, 0); // and lags it every month
  assert.ok(flat.res < 0);
});

test('ranked list: universe rank, ≥ 260 sessions of history, traded in the last 5 sessions; score weights', () => {
  const dates = weekdays('2024-01-01', '2025-06-30');
  seed = 5;
  const nz = dates.map(() => rnd() * 0.01);
  const syms = ['A', 'B', 'C', 'NEW', 'STALE', 'OUT'];
  const drift = { A: 0.003, B: 0.002, C: 0.001, NEW: 0.004, STALE: 0.004, OUT: 0.005 };
  const nn = dates.map(() => rnd() * 0.01);
  const W = makeWorld(syms, dates, { px: (s, i) => 100 * Math.exp(drift[s] * i + nz[i] * (1 + syms.indexOf(s))), nifty: (i) => 10000 * Math.exp(nn[i]) });
  const t = dates.length - 1;
  // NEW only listed 200 sessions ago; STALE stopped trading 10 sessions ago
  const NEW = W.S[W.si.get('NEW')];
  for (let i = 0; i < t - 200; i++) NEW.Cr[i] = NaN;
  NEW.first = t - 200;
  const ST = W.S[W.si.get('STALE')];
  for (let i = t - 9; i <= t; i++) ST.Cr[i] = NaN;
  const rank = Float64Array.from(W.syms.map((s, j) => (s === 'OUT' ? 201 : j + 1))); // OUT is outside the top 200
  const { order, scores } = F2.rankedList(W, t, rank);
  assert.deepEqual(order.map((j) => W.syms[j]), ['A', 'B', 'C']);
  for (const j of order) {
    const s = scores.get(j);
    assert.ok(Number.isFinite(s.score));
  }
  // the score is 0.25·z(r6v) + 0.25·z(r12v) + 0.5·z(res) + 0.5·z(nsm)
  const f = order.map((j) => scores.get(j));
  const zs = Object.fromEntries(['r6v', 'r12v', 'res', 'nsm'].map((k) => [k, F2.zscores(f.map((x) => x[k]))]));
  f.forEach((x, i) => assert.ok(Math.abs(x.score - (0.25 * zs.r6v[i] + 0.25 * zs.r12v[i] + 0.5 * zs.res[i] + 0.5 * zs.nsm[i])) < 1e-12));
  // universe rank from the month's median traded value (≥ 15 sessions)
  const r = F2.rankForMonth(W, '2025-06');
  assert.deepEqual([...r], W.syms.map((s) => syms.indexOf(s) + 1)); // traded value falls with the original list order
});

// ------------------------------------------------------------ the account ---
const DATES = weekdays('2025-01-01', '2025-07-31');
const ORDER0 = SYMS.slice(0, 20);

test('tranche schedule: both tranches fill on the first rebalance, then T2 on even and T1 on odd rebalances', () => {
  const W = makeWorld(SYMS, DATES);
  // rebalance 2 and 3 rank a fresh set first; the off-month tranche must keep its names
  const fresh = SYMS.slice(20, 30);
  const a = runFixed(W, [ORDER0, [...fresh, ...ORDER0], [...fresh, ...ORDER0]]);
  const [r1, r2, r3] = a.rebalances;
  assert.equal(r1.k, 1);
  assert.deepEqual(r1.reranked, ['S1']);
  assert.deepEqual(stocks(r1, 'S1'), ['S00', 'S01', 'S02', 'S03']);
  assert.deepEqual(stocks(r1, 'S2'), ['S04', 'S05', 'S06', 'S07']); // filled although not its re-rank month
  assert.equal(stocks(r1).length, 8); // fully invested from the start
  assert.deepEqual(r2.reranked, ['S2']);
  assert.deepEqual(stocks(r2, 'S1'), ['S00', 'S01', 'S02', 'S03']); // T1 off-month: held
  assert.deepEqual(stocks(r2, 'S2'), ['S04', 'S05', 'S06', 'S07']); // T2 re-ranked but all its names are still in the top 24
  assert.deepEqual(r3.reranked, ['S1']);
  const next = F2.nextRebalance('2026-11-25', 0);
  assert.equal(next.signal, '2026-11-30');
  assert.equal(next.trade, '2026-12-01');
  assert.match(next.tranche, /both tranches/);
  assert.match(F2.nextRebalance('2026-12-02', 1).tranche, /Tranche 2/);
  assert.match(F2.nextRebalance('2027-01-02', 2).tranche, /Tranche 1/);
});

test('keep-in-top-24 buffer: on its month a tranche keeps a name at place 20, sells one at place 25; off-month keeps all', () => {
  const W = makeWorld(SYMS, DATES);
  const rest = SYMS.filter((s) => !['S00', 'S01', 'S04', 'S05'].includes(s));
  // rebalance 2 (T2's month): S04 drops to place 20 (kept), S05 to place 25 (sold); S00/S01 (T1) drop too but T1 is off
  const o2 = [...rest.slice(0, 19), 'S04', ...rest.slice(19, 23), 'S05', 'S00', 'S01', ...rest.slice(23)];
  assert.equal(o2.indexOf('S04'), 19);
  assert.equal(o2.indexOf('S05'), 24);
  const a = runFixed(W, [ORDER0, o2]);
  const r2 = a.rebalances[1];
  assert.ok(stocks(r2, 'S2').includes('S04'));
  assert.ok(!stocks(r2, 'S2').includes('S05'));
  assert.equal(stocks(r2, 'S2').length, 4); // refilled from the top, skipping T1's names
  assert.deepEqual(stocks(r2, 'S1'), ['S00', 'S01', 'S02', 'S03']); // T1 not re-ranked: keeps S00/S01 though they fell to 26/27
  for (const h of r2.holdings.filter((x) => x.part === 'S2')) assert.ok(!['S00', 'S01', 'S02', 'S03'].includes(h.symbol));
});

test('a name whose one REAL share costs more than the slot is skipped (adjusted price would have looked cheap)', () => {
  // slot = ₹1,00,000 × ¼ ÷ 4 = ₹6,250. S00 trades at 100 adjusted but ₹10,000 real (before a later 1:100 split)
  const W = makeWorld(SYMS, DATES, { raw: (s, i, d, c) => (s === 'S00' ? c * 100 : c) });
  assert.equal(W.S[W.si.get('S00')].F[10], 100);
  const r1 = runFixed(W, [ORDER0]).rebalances[0];
  assert.ok(!stocks(r1).includes('S00'));
  assert.deepEqual(stocks(r1, 'S1'), ['S01', 'S02', 'S03', 'S04']);
  // ₹6,000 real is affordable: 6,000 × 1.004 < 6,250
  const W2 = makeWorld(SYMS, DATES, { raw: (s, i, d, c) => (s === 'S00' ? c * 60 : c) });
  assert.ok(stocks(runFixed(W2, [ORDER0]).rebalances[0], 'S1').includes('S00'));
});

test('whole real shares (also for a split-adjusted name) and whole ETF units', () => {
  const W = makeWorld(SYMS, DATES, { px: (s) => 100 + SYMS.indexOf(s) * 7.3, raw: (s, i, d, c) => (s === 'S01' ? c * 2 : c) });
  const a = runFixed(W, [ORDER0]);
  for (const r of a.rebalances) {
    for (const h of r.holdings) assert.ok(Math.abs(h.shares - Math.round(h.shares)) < 1e-9, `${h.symbol} ${h.shares}`);
  }
  const s01 = a.rebalances[0].holdings.find((h) => h.symbol === 'S01');
  const units = a.units.get('S:S01');
  assert.ok(Math.abs(units / 2 - s01.shares) < 1e-9); // adjusted units = 2 × real shares
  assert.ok(Math.abs(s01.entry - 2 * (100 + 7.3)) < 1e-9); // entry shown at the real price
  // ₹1,00,000 → ⅓ gold at ₹100 incl. 0.15% → 332 units; ⅙ Next 50 → 166
  assert.equal(a.rebalances[0].holdings.find((h) => h.part === 'GOLD').shares, 332);
  assert.equal(a.rebalances[0].holdings.find((h) => h.part === 'NN50').shares, 166);
});

test('5-point band: parts reset only when one drifts more than 5 points from target', () => {
  const jump = (k) => (i) => (DATES[i] >= '2025-02-10' ? 100 * k : 100);
  const calm = runFixed(makeWorld(SYMS, DATES, { gold: jump(1.1) }), [ORDER0]);
  assert.equal(calm.rebalances[0].reset, true); // first time
  assert.equal(calm.rebalances[1].reset, false); // gold ≈ 35.5% vs 33.3%: within the band
  assert.ok(Math.abs(calm.rebalances[1].weightsBefore.GOLD - 1 / 3) < 0.05);
  const big = runFixed(makeWorld(SYMS, DATES, { gold: jump(1.3) }), [ORDER0]);
  assert.ok(big.rebalances[1].weightsBefore.GOLD - 1 / 3 > 0.05);
  assert.equal(big.rebalances[1].reset, true);
  const sold = big.rebalances[1].orders.find((o) => o.name === 'GOLD');
  assert.ok(sold && sold.units < 0); // gold trimmed back
  assert.equal(calm.rebalances[1].orders.filter((o) => o.name === 'GOLD' || o.name === 'NN50').length, 0); // no fund trades inside the band
});

test('tax ledger: equity short-term gain taxed at 20% + cess after Jul 2024, carried loss set off', () => {
  const L = new F2.Ledger();
  L.buy('S:X', 10, 100, '2025-05-01', 'eq');
  L.sell('S:X', 10, 150, '2025-08-01');
  assert.ok(Math.abs(L.settle(2025) - 500 * 0.2 * 1.04) < 1e-9);
  const M = new F2.Ledger();
  M.buy('S:Y', 10, 100, '2025-05-01', 'eq');
  M.sell('S:Y', 10, 50, '2025-08-01');
  assert.equal(M.settle(2025), 0);
  M.buy('S:Z', 10, 100, '2026-05-01', 'eq');
  M.sell('S:Z', 10, 160, '2026-08-01');
  assert.ok(Math.abs(M.settle(2026) - 100 * 0.2 * 1.04) < 1e-9); // 600 gain − 500 carried loss
});

// ------------------------------------------------------------- paper walk ---
const PDATES = weekdays('2025-01-01', '2027-01-08');
const PSYMS = SYMS.slice(0, 24);
seed = 3;
const PN = PDATES.map(() => rnd() * 0.012);
const drift = Object.fromEntries(PSYMS.map((s, i) => [s, 0.0002 * (i % 9) - 0.0004]));
const SPLIT = '2026-12-15'; // S08 (a strong name) splits 1:10 between the paper runs
const rawPx = (s, i) => 200 * Math.exp(drift[s] * i + PN[i] * (1 + (PSYMS.indexOf(s) % 5))) / (s === 'S08' && PDATES[i] >= SPLIT ? 10 : 1);
function writeBhav(upTo) {
  rmSync(BHAV, { recursive: true, force: true });
  mkdirSync(BHAV, { recursive: true });
  const months = {};
  PDATES.forEach((d, i) => {
    if (d > upTo) return;
    (months[d.slice(0, 7)] ??= {})[d] = PSYMS.map((s, j) => {
      const c = rawPx(s, i);
      const prev = i ? rawPx(s, i - 1) * (s === 'S08' && d === SPLIT ? 0.1 : 1) : c;
      return [s, c, c * 1.01, c * 0.99, c, prev, 5e9 - j * 1e7];
    });
  });
  for (const [ym, m] of Object.entries(months)) writeFileSync(join(BHAV, `${ym}.json.gz`), gzipSync(JSON.stringify(m)));
}
const fakeCandles = async (sym) => PDATES.map((d, i) => {
  const c = sym === '^NSEI' ? 20000 * Math.exp(PN[i]) : sym === 'GOLDBEES.NS' ? 60 * Math.exp(0.0003 * i) : 500 * Math.exp(0.0002 * i);
  return { date: d, open: c, close: c };
});
const nowAt = (d) => new Date(Date.parse(`${d}T14:00:00Z`));

test('paper walk: waits for the Nov 2026 month-end, buys 1 Dec fully invested, T2 re-ranks next, restore = continuous run', async () => {
  writeFileSync(process.env.INDIA_MIX_PAPER_PATH, JSON.stringify({ startedAt: '2026-10-30', capital: 100000, curve: [{ date: '2026-11-27', value: 101000 }, { date: '2027-01-08', value: 103020 }] }));
  writeBhav('2026-11-27');
  let st = await F2.finalist2PaperUpdate({ loadCandles: fakeCandles, now: nowAt('2026-11-27') });
  assert.equal(st.rebalances.length, 0);
  assert.equal(st.curve.length, 0);
  assert.equal(st.next.signal, '2026-11-30');
  assert.equal(st.next.trade, '2026-12-01');
  assert.equal(st.startMonth, '2026-11');

  writeBhav('2026-12-04');
  st = await F2.finalist2PaperUpdate({ loadCandles: fakeCandles, now: nowAt('2026-12-04') });
  assert.equal(st.rebalances.length, 1);
  const r1 = st.rebalances[0];
  assert.equal(r1.monthEnd, '2026-11-30');
  assert.equal(r1.date, '2026-12-01');
  assert.equal(r1.holdings.filter((h) => h.kind === 'stock' && h.part === 'S1').length, 4);
  assert.equal(r1.holdings.filter((h) => h.kind === 'stock' && h.part === 'S2').length, 4);
  assert.ok(r1.cash < 0.03 * 100000, `cash ${r1.cash}`); // fully invested
  assert.deepEqual(st.curve.map((c) => c.date), ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']);
  assert.ok(st.marks.every((m) => m.entry > 0 && Math.abs(m.shares - Math.round(m.shares)) < 1e-9));
  const s08before = st.marks.find((m) => m.symbol === 'S08');

  writeBhav('2027-01-08');
  st = await F2.finalist2PaperUpdate({ loadCandles: fakeCandles, now: nowAt('2027-01-08') });
  assert.equal(st.rebalances.length, 2);
  assert.equal(st.rebalances[0].date, '2026-12-01'); // the first record is kept as it was
  assert.deepEqual(st.rebalances[1].reranked, ['S2']);
  assert.equal(st.rebalances[1].monthEnd, '2026-12-31');
  assert.match(st.next.tranche, /Tranche 1/);
  // S08 (bought 1 Dec, not traded at the Dec month-end) split 1:10 on 15 Dec: ten times the shares at a tenth of the entry
  assert.ok(s08before, 'S08 held after the first rebalance');
  const s08after = st.marks.find((m) => m.symbol === 'S08');
  assert.ok(st.rebalances[1].orders.every((o) => o.name !== 'S08'));
  assert.equal(Math.round(s08after.shares), Math.round(s08before.shares) * 10);
  assert.ok(Math.abs(s08after.entry - s08before.entry / 10) < 1e-6);
  // one continuous run over the same data gives the same value
  const W = await F2.loadWorld({ loadCandles: fakeCandles, series: loadSeries({ keepRaw: true }) });
  const a = new F2.Account(W, { startMonth: '2026-11' });
  let v;
  for (let t = W.di.get('2026-12-01'); t < W.dates.length; t++) v = a.step(t);
  assert.ok(Math.abs(v - st.curve.at(-1).value) < 1e-6, `${v} vs ${st.curve.at(-1).value}`);
  assert.equal(st.curve.at(-1).date, '2027-01-08');
  // comparison: India mix from its last value on/before 30 Nov, NIFTY from the 30 Nov close
  const c = F2.compareSinceStart(st, JSON.parse(readFileSync(process.env.INDIA_MIX_PAPER_PATH, 'utf8')));
  assert.equal(c.from, '2026-11-30');
  assert.ok(Math.abs(c.indiaMix - 0.02) < 1e-9);
  assert.ok(Math.abs(c.nifty - (st.curve.at(-1).nifty / st.niftyAtStart - 1)) < 1e-12);
  // the card view hides the ledger, keeps holdings and the research table
  const view = F2.finalist2View({ now: nowAt('2027-01-08') });
  assert.equal(view.paper.account, undefined);
  assert.equal(view.research.rows.length, 4);
  assert.match(view.research.verdict, /lost both never-seen periods/);
  assert.match(view.firstMonth, /both tranches/);

  // the Breakdown tab reads its curve
  const bd = await import('./paper-bot/breakdown.mjs');
  const dir = join(TMP, 'bd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'finalist2-paper.json'), readFileSync(process.env.FINALIST2_PAPER_PATH));
  const data = bd.loadAll({ dir });
  assert.ok(data.curves.some((r) => r.strategy === 'finalist2'), 'finalist2 curve rows');
  assert.equal(data.warnings.filter((w) => /finalist2/.test(w)).length, 0);
  const val = bd.validate(data).filter((x) => x.strategy === 'finalist2');
  assert.ok(val.length && val.every((x) => x.pass), JSON.stringify(val.filter((x) => !x.pass)));
  assert.equal(bd.STRATEGIES.finalist2, 'Finalist 2');
});

test('wiring: card after Global mix, route, evening line, research summary; paper only (not in the algo plan)', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.ok(html.indexOf('id="globalCard"') < html.indexOf('id="finalist2Card"') && html.indexOf('id="finalist2Card"') < html.indexOf('id="steadyCard"'));
  assert.match(html, /<h2>Finalist 2 \(heavier momentum\)/);
  assert.match(html, /\/static\/js\/49-finalist-two\.js/);
  assert.match(html, /<li><b>Finalist 2<\/b>[^<]*lost both never-seen periods/);
  const views = readFileSync('static/js/06-home-views.js', 'utf8');
  assert.match(views, /key: 'invest', match: \/\^\([^)]*\|Global mix\|Finalist 2\|/);
  assert.match(views, /'India mix', 'Global mix', 'Finalist 2', 'Steady mix'/);
  assert.match('/static/js/49-finalist-two.js', /^\/static\/(app\.css|js\/\d\d-[a-z-]+\.js)$/); // the server only serves NN-letters.js
  const js = readFileSync('static/js/49-finalist-two.js', 'utf8');
  assert.match(js, /avoidMark\(/);
  assert.match(js, /\/api\/finalist2/);
  assert.match(js, /Not advice\.<\/div>`;\n  }\n  \$\('f2Out'\)/); // the card ends with "Not advice"
  const srv = readFileSync('server.mjs', 'utf8');
  assert.match(srv, /url\.pathname === '\/api\/finalist2'\) return json\(res, 200, finalist2View\(\)\)/);
  const sh = readFileSync('scripts/run.sh', 'utf8');
  assert.match(sh, /node --max-old-space-size=12000 paper-bot\/finalist2\.mjs --paper \|\| true/);
  assert.ok(sh.indexOf('global-mix.mjs --paper') < sh.indexOf('finalist2.mjs --paper'));
  assert.doesNotMatch(readFileSync('paper-bot/algo-plan.mjs', 'utf8'), /finalist2|Finalist 2/i);
  assert.doesNotMatch(readFileSync('static/js/47-algo-plan.js', 'utf8'), /finalist2|Finalist 2/i);
  // the module never trades: no broker calls
  assert.doesNotMatch(readFileSync('paper-bot/finalist2.mjs', 'utf8'), /placeOrder|groww.*order|kite/i);
  assert.ok(readdirSync('paper-bot').includes('finalist2.mjs'));
});
