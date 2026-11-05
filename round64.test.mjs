// Tests for the NIFTY options test on real intraday prices (paper-bot/fo-intraday-backtest.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ft = await import('./paper-bot/fo-intraday-backtest.mjs');
const bar = (date, ts, close) => ({ date, ts, close });

test('nearest strike, only above / below a limit', () => {
  const chain = { 24000: { CE: 'a', PE: 'b' }, 24500: { CE: 'c' }, 23500: { PE: 'd' } };
  assert.equal(ft.nearestStrike(chain, 24400, 'CE', { above: 24100 }), 24500);
  assert.equal(ft.nearestStrike(chain, 23600, 'PE', { below: 24000 }), 23500);
  assert.equal(ft.nearestStrike(chain, 24400, 'PE'), 24000);
});

test('price at a time: the last close at or before it, same day when asked', () => {
  const bars = [bar('2024-01-01 15:15', 10, 5), bar('2024-01-02 09:15', 20, 7)];
  assert.equal(ft.priceAt(bars, 15), 5);
  assert.equal(ft.priceAt(bars, 25), 7);
  assert.equal(ft.priceAt(bars, 25, '2024-01-01'), null, 'an older day\'s price is not an entry price');
});

test('short strangle: held to expiry keeps the credit less the intrinsic value; the stop exits at 2× the credit', () => {
  const ce = [bar('2024-01-01 15:15', 1, 50), bar('2024-01-02 10:00', 2, 120), bar('2024-01-03 15:25', 3, 0.05)];
  const pe = [bar('2024-01-01 15:15', 1, 50), bar('2024-01-02 10:00', 2, 90), bar('2024-01-03 15:25', 3, 0.05)];
  const legs = [{ type: 'CE', k: 22500, q: -1, bars: ce }, { type: 'PE', k: 21500, q: -1, bars: pe }];
  const timeline = [bar('2024-01-02 10:00', 2, 0), bar('2024-01-03 15:25', 3, 0)];
  const base = { legs, entryTs: 1, entryDay: '2024-01-01', timeline, settle: 22000, date: '2024-01-01' };
  const hold = ft.runPosition(base);
  assert.ok(hold.pts > 100 - 5 && hold.pts < 100, `credit 100, nothing in the money, less charges: ${hold.pts}`);
  const stopped = ft.runPosition({ ...base, exitRule: (v, e) => -v >= 2 * -e });
  assert.equal(stopped.how, 'exit');
  assert.ok(stopped.pts < -110 && stopped.pts > -120, `bought back at 210 for a 100 credit, less charges: ${stopped.pts}`);
});

test('debit spread at expiry: worth the strike gap when both end in the money', () => {
  const l = [bar('2024-01-01 15:15', 1, 100)];
  const s = [bar('2024-01-01 15:15', 1, 70)];
  const r = ft.runPosition({ legs: [{ type: 'CE', k: 22000, q: 1, bars: l }, { type: 'CE', k: 22200, q: -1, bars: s }], entryTs: 1, entryDay: '2024-01-01', timeline: [], settle: 22600, date: '2024-01-01' });
  assert.ok(r.pts > 200 - 30 - 5 && r.pts < 170, `200 wide − 30 cost − charges and STT on exercise: ${r.pts}`);
});

test('summary splits 2020–22 / 2023 → and counts early exits', () => {
  const s = ft.summary([{ date: '2021-01-07', rs: 100, how: 'expiry' }, { date: '2024-01-04', rs: -300, how: 'exit' }]);
  assert.equal(s.all.total, -200);
  assert.equal(s.early.trades, 1);
  assert.equal(s.all.exits, 1);
});
