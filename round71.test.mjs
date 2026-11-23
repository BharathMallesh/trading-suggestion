// Tests for the 1:15 PM reversal (YouTube): the level, the trigger and its fill, stop / target, overnight carry (futures
// only for F&O stocks), next-day validity, the risk filter, charges, the account limit, the pass rule — on synthetic
// 5-minute bars. Plus the UI / API / evening-job wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const m = await import('./paper-bot/one-fifteen.mjs');
const { futuresCharges, orderCharges } = await import('./paper-bot/costs.mjs');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const TIMES = [];
for (let t = 9 * 60 + 15; t <= 15 * 60 + 25; t += 5) TIMES.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
/** One session of flat bars at `p`, with { 'HH:MM': { open, high, low, close } } overrides. */
const day = (date, p, over = {}) => TIMES.map((t) => ({ date: `${date} ${t}`, open: p, high: p, low: p, close: p, volume: 1000, ...(over[t] || {}) }));
// A stock that closed at 100, then is up 5% by 13:15; the 1:15 candle is 104–106.
const upDay = (date, extra = {}) => day(date, 105, { '13:10': { close: 105 }, '13:15': { high: 106, low: 104 }, ...extra });

test('setupFor: move at 13:15 vs the previous close, the 13:15–13:45 candle, thresholds and the split guard', () => {
  const bars = upDay('2024-01-02');
  const s = m.setupFor(100, bars);
  close(s.move, 5);
  assert.equal(s.H, 106);
  assert.equal(s.L, 104);
  assert.equal(s.trend, 'up');
  assert.equal(m.setupFor(103, bars), null, '≈ 1.9% move: not a mover');
  assert.equal(m.setupFor(100, bars, { ...m.RULES, moveMin: 6 }), null, '≥ 6% threshold');
  assert.equal(m.setupFor(50, bars), null, '+110% = a split in unadjusted data, skipped');
  // a 13:45 bar that is outside the candle does not change the level
  const b2 = upDay('2024-01-02', { '13:45': { high: 110, low: 100 } });
  assert.equal(m.setupFor(100, b2).H, 106);
});

test('plan: reversal sells below the low after a rise (stop the high); continuation is the mirror', () => {
  const su = { trend: 'up', H: 106, L: 104 };
  assert.deepEqual(m.plan(su), { side: 'short', level: 104, stop: 106 });
  assert.deepEqual(m.plan(su, 'continuation'), { side: 'long', level: 106, stop: 104 });
  assert.deepEqual(m.plan({ trend: 'down', H: 96, L: 94 }), { side: 'long', level: 96, stop: 94 });
});

test('findTrigger: needs a trade THROUGH the level; a gap through fills at the (worse) open; not at/after 15:15', () => {
  const bars = day('2024-01-02', 105, { '14:00': { open: 104.5, low: 103.9, high: 104.6, close: 104 } });
  const k45 = bars.findIndex((b) => b.date.endsWith('13:45'));
  const t = m.findTrigger(bars, k45, { side: 'short', level: 104 });
  assert.equal(bars[t.k].date.slice(11), '14:00');
  assert.equal(t.raw, 104);
  const touch = day('2024-01-02', 105, { '14:00': { low: 104 } });
  assert.equal(m.findTrigger(touch, k45, { side: 'short', level: 104 }), null, 'a touch is not a break');
  const gap = day('2024-01-02', 105, { '14:00': { open: 103.5, high: 103.6, low: 103.2, close: 103.4 } });
  assert.equal(m.findTrigger(gap, k45, { side: 'short', level: 104 }).raw, 103.5, 'gap below the level → the open');
  const late = day('2024-01-02', 105, { '15:15': { low: 103 } });
  assert.equal(m.findTrigger(late, k45, { side: 'short', level: 104 }), null);
});

const noSlip = { ...m.RULES, slippagePct: 0 };

test('same-day version: short at the level, 1R target hit → target; intraday charges; R before vs after costs', () => {
  const d1 = day('2024-01-01', 100);
  const d2 = upDay('2024-01-02', { '14:00': { open: 104.5, high: 104.6, low: 103.9, close: 104 }, '14:30': { open: 103, high: 103, low: 101.9, close: 102 } });
  const [t] = m.simulate('X.NS', [...d1, ...d2], { version: 'S', rules: noSlip });
  assert.equal(t.side, 'short');
  assert.equal(t.entry, 104);
  assert.equal(t.stop, 106);
  assert.equal(t.target, 102);
  assert.equal(t.reason, 'target');
  assert.equal(t.exit, 102);
  assert.equal(t.qty, 500, '₹1,000 ÷ ₹2 risk');
  assert.equal(t.product, 'intraday');
  close(t.rGross, 1);
  assert.ok(t.rNet < 1 && t.rNet > 0.8);
  const ch = orderCharges({ side: 'buy', value: 102 * 500, product: 'intraday', costs: { brokerageIntradayPct: 0.03, brokerageIntradayCap: 20 } }).total
    + orderCharges({ side: 'sell', value: 104 * 500, product: 'intraday', costs: { brokerageIntradayPct: 0.03, brokerageIntradayCap: 20 } }).total;
  close(t.charges, ch);
});

test('stop counted first when stop and target fall in one candle; the entry candle checks only the stop', () => {
  const both = upDay('2024-01-02', { '14:00': { open: 104.5, high: 104.6, low: 103.9, close: 104 }, '14:30': { open: 104, high: 106.5, low: 101.5, close: 104 } });
  const [t] = m.simulate('X.NS', [...day('2024-01-01', 100), ...both], { version: 'S', rules: noSlip });
  assert.equal(t.reason, 'stop');
  assert.equal(t.exit, 106);
  const entryBar = upDay('2024-01-02', { '14:00': { open: 105, high: 106.2, low: 101.5, close: 104 } });
  const [u] = m.simulate('X.NS', [...day('2024-01-01', 100), ...entryBar], { version: 'S', rules: noSlip });
  assert.equal(u.reason, 'stop', 'entry candle reached both: stop (conservative), never the target');
  assert.ok(u.entryBarStop);
  // the colour sensitivity: a red entry candle (high first, then the break) is not stopped there
  const [v] = m.simulate('X.NS', [...day('2024-01-01', 100), ...entryBar], { version: 'S', rules: { ...noSlip, entryBar: 'colour' } });
  assert.notEqual(v.reason, 'stop');
});

test('same-day version exits at 15:15 (open of the 15:15 candle) when neither is hit', () => {
  const d2 = upDay('2024-01-02', { '14:00': { open: 104.5, high: 104.6, low: 103.9, close: 104 }, '14:05': { open: 104, high: 104, low: 103, close: 103 }, '15:15': { open: 103 } });
  const [t] = m.simulate('X.NS', [...day('2024-01-01', 100), ...d2], { version: 'S', rules: noSlip });
  assert.equal(t.reason, '15:15');
  assert.equal(t.exitTime, '15:15');
  assert.equal(t.exit, 103);
});

test('video version: no target today → carried overnight as futures; next day target / stop / 15:15; non-F&O stocks out at 15:15', () => {
  const d2 = upDay('2024-01-02', { '14:00': { open: 104.5, high: 104.6, low: 103.9, close: 104 } });
  // rest of day 2 flat at 105 (above entry, below the stop) — then day 3 falls to the target at 10:00
  for (const b of d2) if (b.date.slice(11) > '14:00') Object.assign(b, { open: 105, high: 105, low: 105, close: 105 });
  const d3 = day('2024-01-03', 105, { '10:00': { open: 104, high: 104, low: 101.5, close: 102 } });
  const rows = [...day('2024-01-01', 100), ...d2, ...d3];
  const [t] = m.simulate('X.NS', rows, { version: 'V', fno: true, rules: noSlip });
  assert.equal(t.carried, true);
  assert.equal(t.reason, 'target');
  assert.equal(t.exitDate, '2024-01-03');
  assert.equal(t.product, 'futures');
  close(t.charges, futuresCharges({ side: 'buy', value: 102 * 500, date: '2024-01-03' }).total + futuresCharges({ side: 'sell', value: 104 * 500, date: '2024-01-03' }).total);
  const [n] = m.simulate('X.NS', rows, { version: 'V', fno: false, rules: noSlip });
  assert.equal(n.carried, false);
  assert.equal(n.reason, '15:15');
  assert.equal(n.exitDate, '2024-01-02');
  assert.equal(n.product, 'intraday');
  // next morning opens above the stop → out at that open (worse than −1R)
  const gapUp = day('2024-01-03', 107);
  const [g] = m.simulate('X.NS', [...day('2024-01-01', 100), ...d2, ...gapUp], { version: 'V', fno: true, rules: noSlip });
  assert.equal(g.reason, 'stop');
  assert.equal(g.exit, 107);
  close(g.rGross, -1.5);
  // the data ends with the trade still carried → open, no result
  const [o] = m.simulate('X.NS', [...day('2024-01-01', 100), ...d2], { version: 'V', fno: true, rules: noSlip });
  assert.equal(o.open, true);
  assert.equal(m.stats([o]).trades, 0);
});

test('next-day validity: an untriggered level trades the next session (intraday, out 15:15); the same-day version drops it', () => {
  const d2 = upDay('2024-01-02'); // never breaks 104 today
  const d3 = day('2024-01-03', 105, { '10:00': { open: 104.5, high: 104.5, low: 103.8, close: 104 }, '15:15': { open: 103.5 } });
  const rows = [...day('2024-01-01', 100), ...d2, ...d3];
  const [t] = m.simulate('X.NS', rows, { version: 'V', rules: noSlip });
  assert.equal(t.fromPrev, true);
  assert.equal(t.setupDate, '2024-01-02');
  assert.equal(t.date, '2024-01-03');
  assert.equal(t.time, '10:00');
  assert.equal(t.reason, '15:15');
  assert.equal(t.carried, false);
  assert.equal(m.simulate('X.NS', rows, { version: 'S', rules: noSlip }).length, 0);
  // valid one extra session only
  const d4 = day('2024-01-04', 105, { '10:00': { open: 104.5, high: 104.5, low: 103.8, close: 104 } });
  assert.equal(m.simulate('X.NS', [...day('2024-01-01', 100), ...d2, ...day('2024-01-03', 105), ...d4], { version: 'V', rules: noSlip }).length, 0);
});

test('risk filter: stop under 0.3% or over 3% of price → no trade', () => {
  const tight = day('2024-01-02', 105, { '13:10': { close: 105 }, '13:15': { high: 105.1, low: 104.9 }, '14:00': { open: 104.95, high: 104.95, low: 104.5, close: 104.6 } });
  assert.equal(m.simulate('X.NS', [...day('2024-01-01', 100), ...tight], { version: 'S', rules: noSlip }).length, 0);
  const wide = day('2024-01-02', 105, { '13:10': { close: 105 }, '13:15': { high: 108, low: 102 }, '14:00': { open: 102.5, high: 102.5, low: 101, close: 101 } });
  assert.equal(m.simulate('X.NS', [...day('2024-01-01', 100), ...wide], { version: 'S', rules: noSlip }).length, 0);
});

test('controls: continuation buys above the high after a rise; fade enters at the 13:45 open with the candle range as stop', () => {
  const d2 = upDay('2024-01-02', { '14:00': { open: 105.5, high: 106.5, low: 105.5, close: 106.4 }, '14:10': { open: 107, high: 108.2, low: 107, close: 108 } });
  const [c] = m.simulate('X.NS', [...day('2024-01-01', 100), ...d2], { version: 'S', mode: 'continuation', rules: noSlip });
  assert.equal(c.side, 'long');
  assert.equal(c.entry, 106);
  assert.equal(c.reason, 'target');
  const [f] = m.simulate('X.NS', [...day('2024-01-01', 100), ...upDay('2024-01-02')], { version: 'S', mode: 'fade', rules: noSlip });
  assert.equal(f.side, 'short');
  assert.equal(f.time, '13:45');
  assert.equal(f.entry, 105);
  assert.equal(f.stop, 107);
  const r1 = m.simulate('X.NS', [...day('2024-01-01', 100), ...upDay('2024-01-02')], { version: 'S', mode: 'random', rules: noSlip });
  const r2 = m.simulate('X.NS', [...day('2024-01-01', 100), ...upDay('2024-01-02')], { version: 'S', mode: 'random', rules: noSlip });
  assert.equal(r1[0].side, r2[0].side, 'random side is seeded (repeatable)');
});

test('charges: futures STT 0.0125% before Oct 2024, 0.02% after, 0.05% from Apr 2026; stamp on buys only; brokerage capped at ₹20', () => {
  const a = futuresCharges({ side: 'sell', value: 1e6, date: '2024-09-30' });
  const b = futuresCharges({ side: 'sell', value: 1e6, date: '2024-10-01' });
  close(a.breakdown.stt, 125);
  close(b.breakdown.stt, 200);
  close(futuresCharges({ side: 'sell', value: 1e6, date: '2026-03-31' }).breakdown.stt, 200);
  close(futuresCharges({ side: 'sell', value: 1e6, date: '2026-04-01' }).breakdown.stt, 500);
  close(b.breakdown.brokerage, 20);
  assert.equal(b.breakdown.stamp, 0);
  close(futuresCharges({ side: 'buy', value: 1e6 }).breakdown.stamp, 20);
  assert.ok(m.roundTrip({ entry: 100, exit: 101, qty: 100, side: 'long', product: 'futures', date: '2025-01-01' }) < m.roundTrip({ entry: 100, exit: 101, qty: 100, side: 'long', product: 'intraday' }));
});

test('account: at most 2 new trades a day, earliest first (ties → bigger move)', () => {
  const t = (s, time, move) => ({ symbol: s, date: '2024-01-02', time, move, net: 1, rNet: 0.1, rGross: 0.2, charges: 1, reason: 'target' });
  const kept = m.accountTrades([t('A', '14:00', 3), t('B', '13:50', 4), t('C', '13:50', 9), t('D', '13:45', 3.5)]);
  assert.deepEqual(kept.map((x) => x.symbol), ['D', 'C']);
});

test('stats and the pre-registered pass rule', () => {
  const mk = (date, rNet) => ({ date, time: '14:00', rNet, rGross: rNet + 0.1, net: rNet * 1000, charges: 50, reason: rNet > 0 ? 'target' : 'stop' });
  const st = m.stats([mk('2024-01-02', 1), mk('2024-01-02', -1), mk('2024-01-03', 1)]);
  assert.equal(st.trades, 3);
  assert.equal(st.days, 2);
  close(st.avgRNet, 1 / 3);
  close(st.winRate, 2 / 3);
  const good = { build: { avgRNet: 0.1 }, check: { avgRNet: 0.1 }, test: { avgRNet: 0.1 }, checkTest: { tDay: 2.5 }, all: { exBest10Rs: 5 } };
  const fade = { build: { avgRNet: 0 }, check: { avgRNet: 0 }, test: { avgRNet: 0.2 } };
  assert.equal(m.passRule(good, fade).pass, true);
  assert.equal(m.passRule({ ...good, test: { avgRNet: -0.01 } }, fade).pass, false);
  assert.equal(m.passRule({ ...good, checkTest: { tDay: 1.9 } }, fade).pass, false);
});

test('UI / API / evening job wiring', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /data-sub="r115"[^>]*>1:15 PM reversal</);
  assert.match(html, /<h2>1:15 PM reversal /);
  assert.match(html, /id="r115Out"/);
  assert.match(html, /static\/js\/44-one-fifteen\.js/);
  const views = readFileSync('static/js/06-home-views.js', 'utf8');
  assert.match(views, /r115: \/\^1:15 PM reversal\//);
  assert.match(views, /\|1:15 PM reversal\|/);
  const js = readFileSync('static/js/44-one-fifteen.js', 'utf8');
  assert.match(js, /\/api\/one-fifteen/);
  assert.match(js, /Not advice\./);
  assert.match(readFileSync('server.mjs', 'utf8'), /\/api\/one-fifteen/);
  const sh = readFileSync('scripts/run.sh', 'utf8');
  assert.match(sh, /one-fifteen\.mjs --paper \|\| true/);
  assert.ok(readFileSync('paper-bot/one-fifteen.md', 'utf8').includes('PRE-REGISTERED') || readFileSync('paper-bot/one-fifteen.md', 'utf8').includes('pre-registered'));
});
