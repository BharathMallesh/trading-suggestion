// Tests for the India mix (⅓ Nifty Next 50 / ⅓ gold / ⅓ Momentum 10).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r48-'));
process.env.INDIA_MIX_PATH = join(TMP, 'im.json');
process.env.INDIA_MIX_PAPER_PATH = join(TMP, 'im-paper.json');
process.env.MOMENTUM10_PAPER_PATH = join(TMP, 'm10-paper.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const im = await import('./paper-bot/india-mix.mjs');

test('mix returns: a third each of Nifty Next 50, gold and Momentum 10, less the re-balance drag', () => {
  const rs = im.indiaMixReturns(['2020-03'], { next50: new Map([['2020-03', -0.3]]), gold: new Map([['2020-03', 0.06]]), stocks: new Map([['2020-03', -0.24]]) });
  assert.ok(Math.abs(rs[0].r - ((-0.3 + 0.06 - 0.24) / 3 - 0.0005)) < 1e-12);
});

test('paper: at the month-end change, buys ⅓ JUNIORBEES, ⅓ GOLDBEES and ⅓ split across the Momentum 10 list', async () => {
  const days = [];
  for (let t = Date.UTC(2026, 8, 1); days.length < 70; t += 86400000) if (new Date(t).getUTCDay() % 6) days.push(new Date(t).toISOString().slice(0, 10));
  const px = { 'JUNIORBEES.NS': 700, 'GOLDBEES.NS': 100, 'AAA.NS': 50, 'BBB.NS': 200 };
  const loadCandles = async (sym, o) => {
    if (sym === '^NSEI') return days.map((date) => ({ date, open: 100, close: 100 }));
    const p = px[sym];
    if (o.range) return [{ date: days.at(-1), open: p, close: p * 1.1 }];
    return days.filter((d) => Date.parse(d) / 1000 > o.period1).map((date) => ({ date, open: p, close: p }));
  };
  const me = days.filter((d) => d.slice(0, 7) < days.at(-1).slice(0, 7)).at(-1); // the latest completed month-end in this data
  const st = await im.indiaMixPaperUpdate({ loadCandles, now: new Date('2026-10-30T10:00:00Z'), m10: { monthEnd: me, list: [{ symbol: 'AAA' }, { symbol: 'BBB' }] } });
  assert.equal(st.rebalances.length, 1);
  assert.equal(st.rebalances[0].monthEnd, me);
  const h = st.rebalances[0].holdings;
  assert.deepEqual(h.map((x) => x.name), ['Nifty Next 50 (JUNIORBEES)', 'Gold (GOLDBEES)', 'AAA', 'BBB']);
  assert.ok(Math.abs(h[0].amount - 100000 / 3) < 1e-6 && Math.abs(h[2].amount - 100000 / 6) < 1e-6);
  assert.ok(st.curve.at(-1).value > 100000 * 1.09, 'every part up 10% at the close, less entry costs');
});
