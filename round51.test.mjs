// Tests for the Matrix calendar (option-selling setup with monthly calendar legs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r51-'));
process.env.MATRIX_CALENDAR_PATH = join(TMP, 'mc.json');
process.env.FO_BHAV_MC_DIR = join(TMP, 'mc');
process.env.FO_BHAV_DIR = join(TMP, 'near');
after(() => rmSync(TMP, { recursive: true, force: true }));
const mc = await import('./paper-bot/matrix-calendar.mjs');

// a simple chain: time value peaks at the money, more for the monthly
const chain = (spot, expiries, tv) => ({
  underlying: spot,
  all: expiries,
  expiries: Object.fromEntries(expiries.map((e, j) => [e, Object.fromEntries(Array.from({ length: 41 }, (_, i) => spot - 2000 + i * 100).map((k) => {
    const t = tv[j] * Math.exp(-(((k - spot) / (400 + 300 * j)) ** 2));
    return [k, { CE: Math.max(spot - k, 0) + t + 0.5, PE: Math.max(k - spot, 0) + t + 0.5, ceVol: 10, peVol: 10 }];
  }))])),
});
const EX = ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24'];

test('monthly = the last expiry of its month after the weekly', () => {
  assert.equal(mc.monthlyAfter(['2026-11-03', '2026-11-10', '2026-11-24', '2026-12-29'], '2026-11-10'), '2026-11-24');
  assert.equal(mc.monthlyAfter(['2026-11-03', '2026-11-24', '2026-12-29'], '2026-11-24'), '2026-12-29');
});

test('six legs: sell 2 × ≈0.23Δ of the NEXT weekly, wings 500 farther, monthly legs at the sold strikes', () => {
  const t = mc.buildLegs(chain(20000, EX, [60, 150, 220, 300]), '2026-11-02');
  assert.equal(t.weekly, '2026-11-10');
  assert.equal(t.monthly, '2026-11-24');
  const [sc, sp, wc, wp, mcall, mput] = t.legs;
  assert.ok(sc.strike > 20000 && sp.strike < 20000 && sc.strike % 100 === 0 && sp.strike % 100 === 0);
  assert.deepEqual([sc.qty, sp.qty, wc.qty, wp.qty, mcall.qty, mput.qty], [-2, -2, 1, 1, 1, 1]);
  assert.equal(wc.strike, sc.strike + 500);
  assert.equal(wp.strike, sp.strike - 500);
  assert.equal(mcall.strike, sc.strike);
  assert.equal(mcall.expiry, '2026-11-24');
});

test('settle: a quiet night earns the decay; the calendar legs soften a volatility jump compared with the iron condor', () => {
  const entry = chain(20000, EX, [60, 150, 220, 300]);
  const t = mc.buildLegs(entry, '2026-11-02');
  const calm = mc.settleAt(structuredClone(t), chain(20000, EX, [40, 120, 210, 295]), '2026-11-02');
  assert.ok(calm.icPts > 0, 'decay helps the condor');
  const t2 = mc.buildLegs(entry, '2026-11-02');
  const jump = mc.settleAt(t2, chain(20000, EX, [90, 230, 330, 450]), '2026-11-02');
  assert.ok(jump.icPts < 0, 'volatility jump hurts the condor');
  assert.ok(jump.mcPts > jump.icPts, 'calendar legs gain when volatility jumps');
});

test('an untraded leg at entry is not used (stale price)', () => {
  const c = chain(20000, EX, [60, 150, 220, 300]);
  for (const row of Object.values(c.expiries['2026-11-10'])) row.ceVol = 0;
  assert.equal(mc.buildLegs(c, '2026-11-02').untraded, true);
});
