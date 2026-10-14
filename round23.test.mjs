// Tests for the swing strategy round 2: market filter, setup choice, improvement grid,
// after-tax portfolio, core + satellite mix, adopted rules and trailing-stop alerts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r23-'));
process.env.JOURNAL_PATH = join(TMP, 'journal.json');
process.env.ATH_SWING_PATH = join(TMP, 'ath-swing.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const a = await import('./paper-bot/ath-swing.mjs');

test('market map: NIFTY above / below its 200-day average', () => {
  const rows = [];
  for (let i = 0; i < 260; i++) rows.push({ date: `d${String(i).padStart(3, '0')}`, close: i < 230 ? 100 + i : 300 - (i - 230) * 10 });
  const m = a.marketMap(rows);
  assert.equal(m.has('d198'), false, 'needs 200 closes');
  assert.equal(m.get('d220'), true);
  assert.equal(m.get('d259'), false, 'after a sharp fall');
});

test('setup choice and market filter gate signals', () => {
  const closes = [];
  for (let i = 0; i < 260; i++) closes.push(100 + i * 0.2);
  const base = closes[closes.length - 1];
  for (let i = 1; i <= 6; i++) closes.push(base + i * 2.5);
  const top = closes[closes.length - 1];
  for (const x of [-1, -2, -1.5, -2.5, -1]) closes.push(top + x);
  closes.push(top + 3);
  let d = new Date('2024-01-01T00:00:00Z');
  let prev = closes[0];
  const rows = closes.map((c) => {
    while ([0, 6].includes(d.getUTCDay())) d = new Date(d.getTime() + 86400000);
    const r = { date: d.toISOString().slice(0, 10), open: prev, high: Math.max(prev, c) * 1.005, low: Math.min(prev, c) * 0.995, close: c };
    prev = c;
    d = new Date(d.getTime() + 86400000);
    return r;
  });
  const bars = a.indicators(rows);
  const i = bars.length - 1;
  assert.equal(a.setupAt(bars, i, { ...a.RULES, setups: 'flag' }).setup, 'flag breakout');
  assert.equal(a.setupAt(bars, i, { ...a.RULES, setups: 'base' }), null);
  const down = new Map([[bars[i].date, false]]);
  assert.equal(a.setupAt(bars, i, { ...a.RULES, marketFilter: true }, { market: down }), null, 'NIFTY below its 200-day average');
  assert.ok(a.setupAt(bars, i, { ...a.RULES, marketFilter: false }, { market: down }), 'filter off: ignored');
  assert.equal(a.VARIANTS.length, 24);
});

test('after-tax portfolio: short-term tax on each year’s net gain, paid on 1 April', () => {
  const t = { symbol: 'A', entryDate: '2023-05-01', exitDate: '2023-06-01', retPct: 0.5, riskPct: 0.1, r: 5, open: false };
  const r = { ...a.RULES, cashRatePct: 0 };
  const pre = a.portfolio([t, { ...t, symbol: 'B', entryDate: '2024-05-01', exitDate: '2024-05-02', retPct: 0 }], r);
  const post = a.portfolio([t, { ...t, symbol: 'B', entryDate: '2024-05-01', exitDate: '2024-05-02', retPct: 0 }], r, { tax: true });
  const gain = pre.finalEquity - r.capital;
  assert.ok(gain > 0);
  assert.ok(Math.abs(post.taxPaid - gain * 0.15 * 1.04) < 1, '15% + cess (FY 2023-24)');
  assert.ok(Math.abs(pre.finalEquity - post.finalEquity - post.taxPaid) < 1);
  assert.equal(a.stcgRate('2025-01-01'), 0.2 * 1.04);
  assert.equal(a.ltcgExemption('2023-01-01'), 100000);
  assert.ok(pre.yearEquity['2024'] > r.capital, '1 January snapshot after the gain');
});

test('yearly returns and core + satellite mix', () => {
  const yr = a.yearlyReturns({ 2020: 100, 2021: 110, 2022: 99 }, 120, '2023');
  assert.ok(Math.abs(yr['2020'] - 0.1) < 1e-12 && Math.abs(yr['2021'] + 0.1) < 1e-12 && Math.abs(yr['2022'] - 120 / 99 + 1) < 1e-12);
  const partial = a.yearlyReturns({ 2022: 100, 2023: 110 }, 115, '2023');
  assert.equal(partial['2023'], undefined, 'the unfinished current year is left out');
  const idx = { 2020: 0.2, 2021: -0.2 };
  const strat = { 2020: 0.05, 2021: 0.05 };
  const m100 = a.mixYears(idx, strat, 1);
  const m80 = a.mixYears(idx, strat, 0.8);
  assert.ok(Math.abs(m100.worstYear + 0.2) < 1e-12);
  assert.ok(Math.abs(m80.worstYear - (0.8 * -0.2 + 0.2 * 0.05)) < 1e-12);
  assert.ok(m80.maxDrawdown < m100.maxDrawdown, 'a slice of the steadier strategy softens the fall');
});

test('adopted rules drive the live scan only when the improvement test adopted them', async () => {
  assert.equal(a.activeRules(null), a.RULES);
  assert.equal(a.activeRules({ improve: { pick: { adopt: false, rules: { chandelierAtr: 4 } } } }), a.RULES);
  assert.equal(a.activeRules({ improve: { pick: { adopt: true, rules: { ...a.RULES, chandelierAtr: 4 } } } }).chandelierAtr, 4);
});

test('trailing-stop alerts: app-managed set is replaced, your own alerts are kept', async () => {
  const j = await import('./paper-bot/journal.mjs');
  await j.addAlert({ symbol: 'INFY', op: 'above', price: 2000, note: 'mine' });
  assert.equal(await j.syncSourceAlerts('swing-paper', [{ symbol: 'BHEL.NS', op: 'below', price: 250.123, note: 'trail' }, { symbol: 'TCS', op: 'below', price: 2200 }]), 2);
  assert.equal(await j.syncSourceAlerts('swing-paper', [{ symbol: 'BHEL.NS', op: 'below', price: 255 }]), 1);
  const st = j.loadJournal();
  assert.equal(st.alerts.filter((x) => x.source === 'swing-paper' && !x.triggeredAt).length, 1);
  assert.equal(st.alerts.find((x) => x.source === 'swing-paper').price, 255);
  assert.ok(st.alerts.some((x) => x.note === 'mine'), 'your own alert untouched');
});
