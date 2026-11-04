// Tests for the iron condor version of the NIFTY strangle (bought wings cap the loss).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r55-'));
process.env.FO_STRANGLE_PATH = join(TMP, 'fo.json');
process.env.FO_STRANGLE_PAPER_PATH = join(TMP, 'fo-paper.json');
process.env.FO_CONDOR_PAPER_PATH = join(TMP, 'condor-paper.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const fo = await import('./paper-bot/fo-strangle.mjs');

// a chain around NIFTY 20,000: option prices fall with distance from the money
const chain = {};
for (let k = 18500; k <= 21500; k += 50) {
  const tv = 150 * Math.exp(-(((k - 20000) / 400) ** 2)) + 0.5;
  chain[k] = { CE: Math.max(20000 - k, 0) + tv, PE: Math.max(k - 20000, 0) + tv, ceVol: 100, peVol: 100 };
}
const day = { underlying: 20000, expiries: { '2026-11-10': chain } };

test('condor = the same sold strikes plus wings 500 points farther out; smaller credit; margin ≈ maximum loss', () => {
  const s = fo.openTrade('2026-11-04', day, fo.RULES);
  const c = fo.openTrade('2026-11-04', day, fo.CONDOR);
  assert.equal(c.callStrike, s.callStrike);
  assert.equal(c.putStrike, s.putStrike);
  assert.equal(c.wingCall, s.callStrike + 500);
  assert.equal(c.wingPut, s.putStrike - 500);
  assert.ok(c.credit < s.credit && c.credit > 0);
  assert.ok(Math.abs(c.margin - (500 - c.credit)) < 1e-9);
  assert.ok(c.costs > s.costs, 'the wings add charges');
});

test('a 5% rally: the strangle loses without limit, the condor at most the wing width less the credit', () => {
  const s = fo.openTrade('2026-11-04', day, fo.RULES);
  const c = fo.openTrade('2026-11-04', day, fo.CONDOR);
  const crash = 21000; // NIFTY +5%
  const ss = fo.settle(s, crash);
  const cs = fo.settle(c, crash);
  assert.ok(ss.pts < cs.pts, 'the condor loses less');
  assert.ok(cs.pts >= -(500 - c.credit) - c.costs - 500 * 0.00125 - 1e-9, `capped: ${cs.pts}`);
  // a quiet week: both keep their credit less charges
  const calm = fo.settle(c, 20010);
  assert.ok(Math.abs(calm.pts - (c.credit - c.costs)) < 1e-9);
});

test('marking an open condor counts the wings', () => {
  const c = fo.openTrade('2026-11-04', day, fo.CONDOR);
  const m = fo.markOpen(c, '2026-11-05', day); // same prices: only the charges are lost
  assert.ok(Math.abs(m.pts + c.costs) < 1e-9);
});
