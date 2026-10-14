// Tests for the trade planner, journal, daily loss limit and price alerts.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r20-'));
process.env.JOURNAL_PATH = join(TMP, 'journal.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => rmSync(process.env.JOURNAL_PATH, { force: true }));

const j = await import('./paper-bot/journal.mjs');
const NOW = new Date('2026-10-14T05:00:00Z'); // 10:30 IST
const bm = async () => ({ horizons: { '1d': { sigmaPct: 1.5, odds: [{ movePct: 1, probUp: 0.22, probDown: 0.23 }, { movePct: 2, probUp: 0.09, probDown: 0.1 }, { movePct: 3, probUp: 0.04, probDown: 0.04 }] } } });

test('plan: shares from % risk, charges, outcomes, rules', async () => {
  const p = await j.planTrade({ symbol: 'tcs', side: 'long', entry: 1000, stop: 990, product: 'intraday', setup: 'VWAP pullback' }, { now: NOW, loadBigMove: bm });
  assert.equal(p.symbol, 'TCS.NS');
  assert.equal(p.qty, 100, '₹1,000 risk / ₹10 per share');
  assert.equal(p.target, 1020, 'default target 2× risk');
  assert.ok(p.lossAtStop > 1000 && p.lossAtStop < 1100);
  assert.ok(p.gainAtTarget > 1850 && p.gainAtTarget < 2000);
  assert.ok(p.rrAfterCosts > 1.7);
  assert.equal(p.allOk, true);
  assert.ok(Math.abs(p.risk.chanceStopDistanceToday - 0.23) < 1e-9, 'a 1% stop on a buy: the chance of a 1% fall');
  assert.equal(p.setup, 'VWAP pullback');
  const bad = await j.planTrade({ symbol: 'TCS', side: 'long', entry: 1000, stop: 1010, target: 990 }, { now: NOW, loadBigMove: bm });
  assert.equal(bad.checks[0].ok, false, 'stop above entry for a buy');
  const tight = await j.planTrade({ symbol: 'TCS', side: 'short', entry: 1000, stop: 1001 }, { now: NOW, loadBigMove: bm });
  assert.equal(tight.checks.find((c) => /noise/.test(c.rule)).ok, false, '0.1% stop is inside normal noise');
  const noOdds = await j.planTrade({ symbol: 'TCS', entry: 1000, stop: 990 }, { now: NOW, loadBigMove: async () => { throw new Error('x'); } });
  assert.equal(noOdds.risk, null);
  assert.equal(noOdds.side, 'long', 'side inferred from the stop');
  await assert.rejects(() => j.planTrade({ symbol: 'TCS', entry: 1000, stop: 1000 }), /different/);
  await assert.rejects(() => j.planTrade({ symbol: '', entry: 1, stop: 2 }), /symbol/);
});

test('journal: save with alerts, close, stats, delete', async () => {
  const t = await j.addTrade({ symbol: 'TCS', side: 'long', entry: 1000, stop: 990, setup: 'Breakout' }, { now: NOW, withAlerts: true, plan: await j.planTrade({ symbol: 'TCS', side: 'long', entry: 1000, stop: 990, setup: 'Breakout' }, { now: NOW, loadBigMove: bm }) });
  assert.equal(t.status, 'open');
  assert.equal(t.qty, 100);
  let st = j.loadJournal();
  assert.equal(st.alerts.length, 2);
  assert.deepEqual(st.alerts.map((a) => [a.op, a.price]), [['below', 990], ['above', 1020]]);
  const r = await j.closeTrade({ id: t.id, exit: 1020 }, { now: NOW });
  assert.equal(r.trade.status, 'closed');
  assert.equal(r.trade.gross, 2000);
  assert.ok(r.trade.net < 2000 && r.trade.net > 1850);
  assert.ok(Math.abs(r.trade.r - r.trade.net / 1000) < 1e-9);
  st = j.loadJournal();
  assert.ok(st.alerts.every((a) => a.triggeredAt === 'closed'), 'its alerts are retired');
  await assert.rejects(() => j.closeTrade({ id: t.id, exit: 1 }), /already closed/);
  const s = j.journalStats();
  assert.equal(s.all.trades, 1);
  assert.equal(s.all.winRate, 1);
  assert.equal(s.bySetup.Breakout.trades, 1);
  assert.equal(s.rulesKept.trades, 1);
  await j.deleteTrade(t.id);
  assert.equal(j.loadJournal().trades.length, 0);
  assert.equal(j.loadJournal().alerts.length, 0);
});

test('daily loss limit: status, rules check, one notification', async () => {
  await j.saveSettings({ capital: 100000, riskPct: 1, dailyLossPct: 2, maxTradesPerDay: 5 });
  const notes = [];
  const notifyFn = (title, msg) => notes.push([title, msg]);
  for (let k = 0; k < 2; k++) {
    const p = await j.planTrade({ symbol: 'INFY', side: 'long', entry: 1000, stop: 990 }, { now: NOW, loadBigMove: bm });
    const t = await j.addTrade({}, { now: NOW, plan: p });
    await j.closeTrade({ id: t.id, exit: 989 }, { now: NOW, notifyFn });
  }
  const today = j.todayStatus(j.loadJournal(), NOW);
  assert.equal(today.trades, 2);
  assert.ok(today.realisedRs < -2000);
  assert.equal(today.limitHit, true);
  assert.equal(notes.length, 1, 'notified once');
  assert.match(notes[0][0], /Daily loss limit/);
  const p = await j.planTrade({ symbol: 'INFY', side: 'long', entry: 1000, stop: 990 }, { now: NOW, loadBigMove: bm });
  assert.equal(p.checks.find((c) => /Daily loss/.test(c.rule)).ok, false);
  assert.equal(p.allOk, false);
  // a new day starts fresh
  const tomorrow = j.todayStatus(j.loadJournal(), new Date('2026-10-15T05:00:00Z'));
  assert.equal(tomorrow.trades, 0);
  assert.equal(tomorrow.limitHit, false);
});

test('settings: validation and limits', async () => {
  await assert.rejects(() => j.saveSettings({ riskPct: 9 }), /5%/);
  await assert.rejects(() => j.saveSettings({ dailyLossPct: 20 }), /10%/);
  await assert.rejects(() => j.saveSettings({ capital: 'abc' }), /Capital/);
  const s = await j.saveSettings({ capital: 250000, maxTradesPerDay: 3 });
  assert.equal(s.capital, 250000);
  assert.equal(s.riskPct, 1, 'others keep their defaults');
});

test('price alerts: crossing between checks is caught once, notified once', async () => {
  const a = await j.addAlert({ symbol: 'reliance', op: 'above', price: 1500, note: 'breakout' }, { now: NOW });
  await j.addAlert({ symbol: 'RELIANCE', op: 'below', price: 1400 }, { now: NOW });
  assert.equal(a.symbol, 'RELIANCE.NS');
  const t0 = NOW.getTime() / 1000;
  const bars = [{ ts: t0 + 300, high: 1490, low: 1480 }, { ts: t0 + 600, high: 1502, low: 1488 }, { ts: t0 + 900, high: 1495, low: 1485 }];
  const notes = [];
  const fired = await j.checkAlerts({ loadCandles: async () => bars, now: new Date(NOW.getTime() + 15 * 60000), notifyFn: (t, m) => notes.push(m) });
  assert.equal(fired.length, 1, 'the 1,502 spike between checks triggers "above 1500"');
  assert.equal(fired[0].triggerPrice, 1502);
  assert.match(notes[0], /Rose above ₹1500 — breakout/);
  const again = await j.checkAlerts({ loadCandles: async () => bars, now: new Date(NOW.getTime() + 20 * 60000), notifyFn: (t, m) => notes.push(m) });
  assert.equal(again.length, 0);
  assert.equal(notes.length, 1);
  // a bar from before the alert existed does not trigger it
  await j.addAlert({ symbol: 'TCS', op: 'below', price: 900 }, { now: new Date(NOW.getTime() + 3600000) });
  const old = await j.checkAlerts({ loadCandles: async () => [{ ts: t0, high: 950, low: 880 }], now: new Date(NOW.getTime() + 3700000) });
  assert.equal(old.length, 0);
  await assert.rejects(() => j.addAlert({ symbol: 'TCS', op: 'sideways', price: 1 }), /rises above/);
});
