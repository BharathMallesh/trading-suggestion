// Tests for the Breakfast strategy: sector picks at 9:20, entries, 1% stop / target, 9:45 exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const bf = await import('./paper-bot/breakfast.mjs');

/** 14 Oct 5-minute bars after a 13 Oct close `prev`: the 9:15 candle closes at `first`, then the closes follow `path`. */
function session(_unused, prev, first, path) {
  const times = [];
  for (let m = 9 * 60 + 15; m <= 15 * 60 + 25; m += 5) times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  let p = first;
  const out = [{ date: `2026-10-13 15:25`, open: prev, high: prev, low: prev, close: prev }];
  times.forEach((t, i) => {
    const o = i === 0 ? prev : p;
    const c = i === 0 ? first : (path[i - 1] ?? p);
    out.push({ date: `2026-10-14 ${t}`, open: o, high: Math.max(o, c) + 0.01, low: Math.min(o, c) - 0.01, close: c });
    p = c;
  });
  return bf.sessionsOf(out);
}

test('picks: strongest sector → strongest stock under 5%; weakest sector → weakest stock', () => {
  const mk = (s, sector, firstPct) => ({ s, sector, sessions: session(0, 100, 100 * (1 + firstPct / 100), []) });
  const stocks = [
    mk('A1', 'IT', 1.2), mk('A2', 'IT', 0.8), mk('A3', 'IT', 6), // A3 up 6%: don't chase
    mk('B1', 'Auto', 0.2), mk('B2', 'Auto', 0.1), mk('B3', 'Auto', -0.1),
    mk('C1', 'Metals', -1.5), mk('C2', 'Metals', -0.9), mk('C3', 'Metals', -0.4),
    mk('D1', 'Tiny', 9), // sector with < 3 stocks is ignored
  ];
  const nifty = session(0, 100, 100.3, []);
  const p = bf.picksFor('2026-10-14', stocks, nifty);
  assert.equal(p.sectors[0].name, 'IT');
  assert.equal(p.long.symbol, 'A1', 'A3 is up 6% — skipped');
  assert.equal(p.short.symbol, 'C1');
  assert.ok(Math.abs(p.niftyMove - 0.3) < 1e-9);
  assert.ok(!p.sectors.some((x) => x.name === 'Tiny'));
});

test('simulate: target, stop (first inside a candle), 9:45 exit, smaller target when NIFTY is against', () => {
  const pick = { symbol: 'A1', sector: 'IT', move: 1 };
  // rises steadily after entry → 1% target hit
  const up = session(0, 100, 101, Array.from({ length: 20 }, (_, i) => 101 + (i + 1) * 0.3)).get('2026-10-14');
  const t1 = bf.simulate(pick, 'long', up, 0.3);
  assert.equal(t1.reason, 'target');
  assert.equal(t1.targetPct, 1);
  assert.ok(t1.net > 0 && t1.charges > 0);
  assert.equal(t1.qty, Math.floor(500000 / t1.entry));
  // NIFTY negative → long target only 0.5%
  const t2 = bf.simulate(pick, 'long', up, -0.4);
  assert.equal(t2.targetPct, 0.5);
  // falls → 1% stop
  const down = session(0, 100, 101, Array.from({ length: 20 }, (_, i) => 101 - (i + 1) * 0.3)).get('2026-10-14');
  const t3 = bf.simulate(pick, 'long', down, 0.3);
  assert.equal(t3.reason, 'stop');
  assert.ok(t3.net < -4500, 'about 1% of ₹5 lakh plus charges');
  // flat → out at 9:45
  const flat = session(0, 100, 101, Array.from({ length: 70 }, () => 101.05)).get('2026-10-14');
  const t4 = bf.simulate(pick, 'long', flat, 0.3);
  assert.equal(t4.reason, '9:45');
  // short mirrors: falling price hits the short's target
  const t5 = bf.simulate({ ...pick, move: -1 }, 'short', down, -0.3);
  assert.equal(t5.reason, 'target');
  assert.ok(t5.net > 0);
  // live before 9:45 with no exit yet → open
  const early = { bars: flat.bars.filter((b) => b.date <= '2026-10-14 09:25'), prevClose: 100 };
  assert.equal(bf.simulate(pick, 'long', early, 0.3, bf.RULES, { live: true }).open, true);
  assert.equal(bf.simulate(pick, 'long', { bars: flat.bars.slice(0, 1), prevClose: 100 }, 0.3), null, 'no 9:20 candle yet');
});

test('summary: per-day t, exits and drawdown', () => {
  const s = bf.summarise([
    { date: 'd1', net: 4000, gross: 4200, charges: 200, reason: 'target' },
    { date: 'd2', net: -5300, gross: -5100, charges: 200, reason: 'stop' },
    { date: 'd3', net: 500, gross: 700, charges: 200, reason: '9:45' },
    { date: 'd3', net: 0, gross: 0, charges: 0, reason: 'open', open: true },
  ]);
  assert.equal(s.trades, 3);
  assert.equal(s.totalNetRs, -800);
  assert.deepEqual(s.exits, { target: 1, stop: 1, '9:45': 1 });
  assert.equal(s.maxDrawdownRs, 5300);
});
