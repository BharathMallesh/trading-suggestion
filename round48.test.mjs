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
  // charges on the first buy: 0.55% of everything bought (no liquid part)
  assert.ok(Math.abs(st.rebalances[0].cost - 100000 * 0.0055) < 1e-6);
  assert.ok(Math.abs(h[0].amount - (100000 - st.rebalances[0].cost) / 3) < 1e-6 && Math.abs(h[2].amount - (100000 - st.rebalances[0].cost) / 6) < 1e-6);
  assert.ok(st.curve.at(-1).value > 100000 * 1.09, 'every part up 10% at the close, less entry costs');
});

test('a second month with flat prices and the same holdings costs nothing (charges only on what changes)', async () => {
  const { rmSync } = await import('node:fs');
  rmSync(process.env.INDIA_MIX_PAPER_PATH, { force: true });
  const days = [];
  for (let t = Date.UTC(2026, 9, 1); days.length < 45; t += 86400000) if (new Date(t).getUTCDay() % 6) days.push(new Date(t).toISOString().slice(0, 10));
  const flat = (upTo) => async (sym, o) => {
    const ds = days.filter((d) => d <= upTo);
    if (sym === '^NSEI') return ds.map((date) => ({ date, open: 100, close: 100 }));
    if (o.range) return [{ date: ds.at(-1), open: 100, close: 100 }];
    return ds.filter((d) => Date.parse(d) / 1000 > o.period1).map((date) => ({ date, open: 100, close: 100 }));
  };
  const octEnd = days.filter((d) => d.startsWith('2026-10')).at(-1);
  const novEnd = days.filter((d) => d.startsWith('2026-11')).at(-1);
  const list = [{ symbol: 'AAA' }, { symbol: 'BBB' }];
  const firstDec = days.find((d) => d.startsWith('2026-12')) || novEnd;
  let st = await im.indiaMixPaperUpdate({ loadCandles: flat(days.find((d) => d > octEnd)), now: new Date('2026-10-01T10:00:00Z'), m10: { monthEnd: octEnd, list } });
  assert.equal(st.rebalances.length, 1);
  const v1 = st.rebalances[0].value;
  st = await im.indiaMixPaperUpdate({ loadCandles: flat(firstDec), now: new Date(`${firstDec}T12:00:00Z`), m10: { monthEnd: novEnd, list } });
  assert.equal(st.rebalances.length, 2);
  assert.ok(st.rebalances[1].cost < 1e-6, `no charges for an unchanged portfolio, got ${st.rebalances[1].cost}`);
  assert.ok(Math.abs(st.rebalances[1].value - v1) < 1e-6);
});

test('waits for the Momentum 10 list of the month-end instead of parking the stock third in cash', async () => {
  const { rmSync } = await import('node:fs');
  rmSync(process.env.INDIA_MIX_PAPER_PATH, { force: true });
  const days = [];
  for (let t = Date.UTC(2026, 9, 1); days.length < 26; t += 86400000) if (new Date(t).getUTCDay() % 6) days.push(new Date(t).toISOString().slice(0, 10));
  const octEnd = days.filter((d) => d.startsWith('2026-10')).at(-1);
  const firstNov = days.find((d) => d.startsWith('2026-11'));
  const load = async (sym, o) => {
    if (sym === '^NSEI') return days.map((date) => ({ date, open: 100, close: 100 }));
    if (o.range) return [{ date: days.at(-1), open: 100, close: 100 }];
    return days.filter((d) => Date.parse(d) / 1000 > o.period1).map((date) => ({ date, open: 100, close: 100 }));
  };
  // the list is still September's: no re-balance yet
  let st = await im.indiaMixPaperUpdate({ loadCandles: load, now: new Date('2026-10-28T12:00:00Z'), m10: { monthEnd: '2026-09-30', list: [{ symbol: 'OLD' }] } }); // record starts in late October, like the real one
  assert.equal(st.rebalances.length, 0);
  // next run: October's list is ready → bought at the first November open, with the stocks
  st = await im.indiaMixPaperUpdate({ loadCandles: load, now: new Date(`${firstNov}T14:00:00Z`), m10: { monthEnd: octEnd, list: [{ symbol: 'AAA' }, { symbol: 'BBB' }] } });
  assert.equal(st.rebalances.length, 1);
  assert.equal(st.rebalances[0].date, firstNov);
  assert.deepEqual(st.rebalances[0].holdings.filter((h) => h.kind === 'stock').map((h) => h.name), ['AAA', 'BBB']);
});
