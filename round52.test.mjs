// Tests for the swing trade plan (buys, sells, stops for the wide-trail swing).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r52-'));
process.env.SWING_SCAN_PATH = join(TMP, 'scan.json');
process.env.ATH_PAPER_PATH = join(TMP, 'ath-paper.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const tp = await import('./paper-bot/trade-plan.mjs');
const { wideRules } = await import('./paper-bot/ath-swing.mjs');
const r = wideRules();

test('shares: 1.5% of capital at risk, capped at 20% of capital in one stock', () => {
  assert.equal(tp.sharesFor(1000000, 1000, 900, r), 150); // risk binds: ₹15,000 ÷ ₹100 = 150 (cap would allow 200)
  assert.equal(tp.sharesFor(500000, 1000, 990, r), 100); // cap binds: risk allows 750, 20% of ₹5 lakh = 100 shares
  assert.equal(tp.sharesFor(500000, 1000, 1000, r), 0);
});

const slip = 1 - r.slippagePct / 100;
const open = (symbol, entry, stop, trail, last, extra = {}) => ({ symbol: `${symbol}.NS`, version: 'wide', open: true, entryDate: '2026-10-20', entry, stop, trail, exit: last * slip, r: (last - entry) / (entry - stop), ...extra });

test('plan: buys sized for the capital, held stocks keep their stop, a close below the trail is a sell, held names are not re-bought', () => {
  const paper = {
    startedAt: '2026-10-14',
    trades: [
      open('AAA', 100, 90, 95, 110),
      open('BBB', 200, 180, 190, 188), // closed below its trailing stop → sell at the next open
      { symbol: 'CCC.NS', version: 'wide', open: false, entryDate: '2026-10-15', exitDate: '2026-10-30', entry: 50, stop: 45, exit: 46, r: -0.8, reason: 'chandelier', retPct: -0.08, days: 10 },
      open('ZZZ', 100, 90, 95, 99, { version: 'improved' }), // another version: ignored
    ],
  };
  const scan = { date: '2026-10-30', triggered: [{ symbol: 'NEW.NS', setup: 'flag', close: 500, stop: 480, riskPct: 4 }, { symbol: 'AAA.NS', setup: 'base', close: 110, stop: 100, riskPct: 9 }] };
  const p = tp.tradePlan({ capital: 1000000, paper, scan, r });
  assert.deepEqual(p.counts, { buy: 1, sell: 1, hold: 1, freeSlots: r.maxOpen - 2 });
  const nb = p.buy.find((b) => b.symbol === 'NEW');
  assert.equal(nb.action, 'buy');
  assert.equal(nb.shares, 400); // ₹15,000 risk ÷ ₹20 = 750, capped at ₹2 lakh ÷ 500 = 400
  assert.equal(p.buy.find((b) => b.symbol === 'AAA').why, 'already held');
  const a = p.hold.find((h) => h.symbol === 'AAA');
  assert.equal(a.action, 'hold');
  assert.equal(a.stop, 95);
  assert.ok(a.stopRaised);
  assert.ok(Math.abs(a.last - 110) < 1e-9, 'latest close recovered from the slippage-adjusted mark');
  assert.equal(p.hold.find((h) => h.symbol === 'BBB').action, 'sell');
  assert.deepEqual(p.sold.map((s) => s.symbol), ['CCC']);
});

test('plan: no new buys once all slots are taken', () => {
  const trades = Array.from({ length: r.maxOpen }, (_, i) => open(`H${i}`, 100, 90, 92, 105));
  const p = tp.tradePlan({ capital: 1000000, paper: { trades }, scan: { date: '2026-10-30', triggered: [{ symbol: 'NEW.NS', setup: 'flag', close: 500, stop: 480, riskPct: 4 }] }, r });
  assert.equal(p.counts.buy, 0);
  assert.match(p.buy[0].why, /slots used/);
});
