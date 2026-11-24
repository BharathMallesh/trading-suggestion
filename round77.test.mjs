// Tests for Afternoon trend (paper-bot/afternoon-trend.mjs), the loop-23 option-buying near-miss "T1", PAPER ONLY:
//  • the 12:25 signal on synthetic NIFTY bars (±0.4% from the 09:15 open + the extreme close in the last 30 minutes),
//    and that bars after 12:25 are never read;
//  • never on a NIFTY expiry day (expiry.mjs), the nearest NON-expiring weekly and the ATM strike;
//  • stop −20% / target +50% / 15:15 on 5-minute closes, in that order, from the 12:30 bar (earlier bars unused);
//  • sizing floor(₹2,000 ÷ (cost × 65 × 0.2)) and "skipped: one lot exceeds 2% risk"; "no option data", never a guess;
//  • the costs (STT 0.15% on the sale from Apr 2026) against the research's own formula (verify_t1.mjs);
//  • the scorecard maths (win rate, average, ₹, day-clustered t, 31.2% tax by FY with carry-forward, arbitrage, NIFTY);
//  • the paper walk on a temp file (starts the next session, --date = TEST entry not scored), the Breakdown adapter
//    (validation passes, tests left out) and the UI / server / run.sh wiring.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r77-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
process.env.AFTERNOON_TREND_PAPER_PATH = join(TMP, 'afternoon-trend-paper.json');

const AT = await import('./paper-bot/afternoon-trend.mjs');
const { RULES } = AT;

// ------------------------------------------------------------------ helpers ---
const times = () => {
  const out = [];
  for (let m = 9 * 60 + 15; m <= 15 * 60 + 25; m += 5) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
};
/** NIFTY bars for `date`: close(i, hhmm) gives each bar's close; the 09:15 open is `open`. */
function nifty(date, close, open = 20000) {
  return times().map((t, i) => ({ date: `${date} ${t}`, open: i === 0 ? open : close(i - 1, t), close: close(i, t), volume: 0 }));
}
/** Option bars for `date` from a map hhmm → close (others: `base`), volume 10 unless listed in `dead`. */
function opt(date, closes = {}, base = 100, dead = []) {
  return times().map((t) => ({ date: `${date} ${t}`, close: closes[t] ?? base, volume: dead.includes(t) ? 0 : 10 }));
}
const D = '2026-11-26'; // a Thursday, not a NIFTY expiry
const noExpiry = () => false;

// ------------------------------------------------------------------ signal ---
test('signal: up / down trend at 12:25, threshold, extreme in the last 30 minutes, needs the 12:25 bar', () => {
  // steady rise to +0.5% by 12:25, highest close at 12:25 → call
  const up = nifty(D, (i, t) => (t <= '12:25' ? 20000 * (1 + 0.005 * (i / 38)) : 19000));
  const s = AT.detectSignal(up);
  assert.equal(s.type, 'CE');
  assert.ok(Math.abs(s.move - 0.005) < 1e-9);
  assert.equal(s.bar, '12:25');
  // after-12:25 bars crashed to 19000 above: never read (no look-ahead); a different afternoon gives the same signal
  assert.deepEqual(AT.detectSignal(nifty(D, (i, t) => (t <= '12:25' ? 20000 * (1 + 0.005 * (i / 38)) : 25000))), s);
  // mirror: falling → put
  assert.equal(AT.detectSignal(nifty(D, (i, t) => (t <= '12:25' ? 20000 * (1 - 0.005 * (i / 38)) : 20000))).type, 'PE');
  // only +0.3% → no signal
  const small = AT.detectSignal(nifty(D, (i) => 20000 * (1 + 0.003 * (i / 38))));
  assert.equal(small.type, null);
  assert.match(small.reason, /^no signal: NIFTY 0\.30% from the open \(needs ±0\.4%\)/);
  // exactly +0.4% counts (≥)
  assert.equal(AT.detectSignal(nifty(D, (i, t) => (t === '12:25' ? 20080 : 20000 + i))).type, 'CE');
  // +0.6% but the high was at 11:00 (more than 30 minutes before 12:25) → no signal
  const old = AT.detectSignal(nifty(D, (i, t) => (t === '11:00' ? 20200 : t <= '12:25' && t > '11:00' ? 20120 : 20000)));
  assert.equal(old.type, null);
  assert.match(old.reason, /highest close was not in the last 30 minutes/);
  // the high at 12:00 (the first of the last 6 bars) still counts
  assert.equal(AT.detectSignal(nifty(D, (i, t) => (t === '12:00' ? 20200 : t > '12:00' && t <= '12:25' ? 20120 : 20000))).type, 'CE');
  // missing bars: no 12:25 bar / no 09:15 bar → retry, not a "no signal"
  const no1225 = AT.detectSignal(nifty(D, (i) => 20000 + i * 5).filter((b) => !b.date.endsWith('12:25')));
  assert.equal(no1225.type, null);
  assert.equal(no1225.retry, true);
  assert.equal(AT.detectSignal([]).reason, 'no NIFTY 5-minute bars');
});

// ------------------------------------------------------------------ expiry, strike ---
test('never on a NIFTY expiry day; nearest non-expiring weekly; ATM strike', async () => {
  const { isExpiryDay } = await import('./paper-bot/expiry.mjs');
  assert.equal(isExpiryDay('2026-11-23', 'NIFTY'), true, 'Mon 23 Nov 2026: the weekly moved back from the 24 Nov holiday');
  assert.equal(isExpiryDay('2026-11-25', 'NIFTY'), false);
  const bars = nifty('2026-11-23', (i, t) => (t <= '12:25' ? 20000 * (1 - 0.01 * (i / 38)) : 19800));
  let asked = 0;
  const rec = await AT.evaluateDay({ date: '2026-11-23', niftyBars: bars, getOptions: async () => { asked++; return null; } });
  assert.equal(rec.status, 'skip');
  assert.match(rec.reason, /^expiry day/);
  assert.equal(rec.signal.type, 'PE', 'the signal is still recorded');
  assert.equal(asked, 0, 'no option prices asked for on an expiry day');
  // expiry: strictly after the day (same-day expiry never chosen)
  assert.equal(AT.pickExpiry('2026-12-01', ['2026-12-08', '2026-12-01', '2026-12-29']), '2026-12-08');
  assert.equal(AT.pickExpiry('2026-11-25', ['2026-12-08', '2026-12-01']), '2026-12-01');
  assert.equal(AT.pickExpiry('2026-12-30', ['2026-12-29']), null);
  // strike: nearest listed strike of that type, lower on a tie, none beyond 75 points
  const chain = { 25400: { CE: 'a', PE: 'b' }, 25450: { CE: 'c' }, 25500: { CE: 'e', PE: 'f' } };
  assert.equal(AT.pickStrike(chain, 25462, 'CE'), 25450);
  assert.equal(AT.pickStrike(chain, 25462, 'PE'), 25500);
  assert.equal(AT.pickStrike(chain, 25425, 'CE'), 25400, 'tie → the lower strike');
  assert.equal(AT.pickStrike(chain, 25560, 'PE'), 25500);
  assert.equal(AT.pickStrike(chain, 25600, 'PE'), null, '100 points from the nearest put → none');
  assert.equal(AT.pickStrike({ 25000: { CE: 'x' } }, 25100, 'CE'), null, '100 points away → none');
});

// ------------------------------------------------------------------ exits ---
test('exit order on 5-minute closes: stop / target / 15:15, from the 12:30 bar only', () => {
  // entry 12:30 close 100; a crash before 12:30 is not read
  const pre = { '11:00': 5, '12:25': 300 };
  let p = AT.simulateExit(opt(D, { ...pre, '12:30': 100, '13:00': 79, '13:05': 160 }), D);
  assert.deepEqual(p.entry, { time: '12:30', price: 100 });
  assert.deepEqual(p.exit, { time: '13:00', price: 79, why: 'stop' });
  // exactly −20% stops; exactly +50% hits the target
  assert.equal(AT.simulateExit(opt(D, { '12:30': 100, '13:00': 80 }), D).exit.why, 'stop');
  p = AT.simulateExit(opt(D, { '12:30': 100, '12:45': 150, '13:00': 70 }), D);
  assert.deepEqual(p.exit, { time: '12:45', price: 150, why: 'target' });
  // target first in time wins over a later stop; a stop first wins over a later target
  assert.equal(AT.simulateExit(opt(D, { '12:30': 100, '13:00': 79, '13:05': 160 }), D).exit.why, 'stop');
  // neither: out at the 15:15 bar close (not 15:20 / 15:25)
  p = AT.simulateExit(opt(D, { '12:30': 100, '15:15': 110, '15:20': 200 }), D);
  assert.deepEqual(p.exit, { time: '15:15', price: 110, why: '15:15' });
  // an untraded 12:30 bar: entry at the next traded bar; untraded bars are skipped for exits too
  p = AT.simulateExit(opt(D, { '12:30': 100, '12:35': 90, '13:00': 60, '13:05': 140 }, 100, ['12:30', '13:00']), D);
  assert.deepEqual(p.entry, { time: '12:35', price: 90 });
  assert.equal(p.exit.why, 'target');
  assert.equal(p.exit.time, '13:05');
  // no traded bar from 12:30 to 15:10 → null (no data)
  assert.equal(AT.simulateExit(opt(D, {}, 100, times().filter((t) => t >= '12:30')), D), null);
  assert.equal(AT.simulateExit([], D), null);
});

// ------------------------------------------------------------------ costs and sizing ---
test('costs match the research formula; sizing and the 2% skip', async () => {
  // verify_t1.mjs: chg = brk + ex + sebi + (sell ? STT : stamp) + 0.18 (brk + ex + sebi); slippage max(0.5%, 0.05)
  const chg = (p, d, lot, side) => { const brk = 20 / lot, ex = (p * (d < '2024-10-01' ? 0.05 : 0.03503)) / 100, sebi = p * 1e-6; return brk + ex + sebi + (side === 'sell' ? (p * (d < '2026-04-01' ? 0.1 : 0.15)) / 100 : p * 3e-5) + 0.18 * (brk + ex + sebi); };
  for (const [p, side] of [[100, 'buy'], [100, 'sell'], [7.3, 'sell'], [250, 'buy']]) assert.ok(Math.abs(AT.charges(p, D, 65, side) - chg(p, D, 65, side)) < 1e-12);
  assert.ok(Math.abs(AT.charges(100, '2026-11-26', 65, 'sell') - AT.charges(100, '2026-03-31', 65, 'sell') - 0.05) < 1e-12, 'STT 0.15% from 1 Apr 2026 (was 0.1%)');
  assert.equal(AT.fillBuy(100), 100.5);
  assert.equal(AT.fillSell(100), 99.5);
  assert.equal(AT.fillBuy(4), 4.05, '₹0.05 minimum');
  // sizing: floor(2000 / (cost × 65 × 0.2))
  assert.equal(AT.sizeLots(150, 65), 1); // 2000 / 1950
  assert.equal(AT.sizeLots(50, 65), 3); // 2000 / 650 = 3.08
  assert.equal(AT.sizeLots(154, 65), 0); // 2000 / 2002
  assert.equal(AT.sizeLots(50, 65, RULES, 5000), 1, 'never more premium than the account');
  // a trade that does not fit → the skip reason
  const up = nifty(D, (i, t) => (t <= '12:25' ? 20000 * (1 + 0.006 * (i / 38)) : 20200));
  const big = await AT.evaluateDay({ date: D, niftyBars: up, isExpiry: noExpiry, getOptions: async () => ({ expiry: '2026-12-01', strike: 20100, symbol: 'X', bars: opt(D, { '12:30': 200 }, 200) }) });
  assert.equal(big.status, 'skip');
  assert.equal(big.reason, 'skipped: one lot exceeds 2% risk');
  // a trade that fits: 2 lots at 70 (2000 / (70.6 × 65 × 0.2) = 2.18)
  const ok = await AT.evaluateDay({ date: D, niftyBars: up, isExpiry: noExpiry, getOptions: async ({ type, spot }) => {
    assert.equal(type, 'CE');
    assert.ok(Math.abs(spot - 20120) < 1e-6, 'spot = the 12:25 close');
    return { expiry: '2026-12-01', strike: 20100, symbol: 'NSE-NIFTY-01Dec26-20100-CE', bars: opt(D, { '12:30': 70, '14:00': 105 }, 70) };
  } });
  assert.equal(ok.status, 'trade');
  assert.equal(ok.lots, 2);
  assert.equal(ok.lot, 65);
  assert.equal(ok.exit.why, 'target');
  const cost = 70 + 0.35 + chg(70, D, 65, 'buy');
  const proc = 105 - 0.525 - chg(105, D, 65, 'sell');
  assert.ok(Math.abs(ok.ret - (proc - cost) / cost) < 1e-12);
  assert.ok(Math.abs(ok.pnl - (proc - cost) * 130) < 1e-9);
});

test('no option data: an error, no strike or no bars → "no option data" (retried), never a guess', async () => {
  const down = nifty(D, (i, t) => (t <= '12:25' ? 20000 * (1 - 0.006 * (i / 38)) : 19800));
  const a = await AT.evaluateDay({ date: D, niftyBars: down, isExpiry: noExpiry, getOptions: async () => { throw new Error('Groww token request failed'); } });
  assert.equal(a.reason, 'no option data');
  assert.equal(a.retry, true);
  assert.match(a.detail, /Groww/);
  assert.equal(a.pnl, undefined);
  const b = await AT.evaluateDay({ date: D, niftyBars: down, isExpiry: noExpiry, getOptions: async () => ({ expiry: '2026-12-01', strike: 19900, bars: [] }) });
  assert.equal(b.reason, 'no option data');
  assert.equal(b.entry, undefined);
  const c = await AT.evaluateDay({ date: D, niftyBars: down, isExpiry: noExpiry, getOptions: async () => ({ expiry: '2026-12-01', strike: null }) });
  assert.equal(c.reason, 'no option data');
  // bars of another day are not used
  const d = await AT.evaluateDay({ date: D, niftyBars: down, isExpiry: noExpiry, getOptions: async () => ({ expiry: '2026-12-01', strike: 19900, bars: opt('2026-11-27', { '12:30': 50 }) }) });
  assert.equal(d.reason, 'no option data');
  // no NIFTY bars → skipped and retried, options never asked
  const e = await AT.evaluateDay({ date: D, niftyBars: [], isExpiry: noExpiry, getOptions: async () => assert.fail('not asked') });
  assert.equal(e.reason, 'no NIFTY 5-minute bars');
  assert.equal(e.retry, true);
});

// ------------------------------------------------------------------ scorecard ---
test('scorecard maths: n, win rate, average, ₹, day-clustered t, tax by FY with carry-forward, arbitrage, NIFTY', () => {
  const tr = (date, ret, pnl) => ({ date, status: 'trade', ret, pnl, exit: { why: pnl > 0 ? 'target' : 'stop' } });
  const days = [
    tr('2026-11-25', 0.5, 5000), { date: '2026-11-26', status: 'skip', reason: 'no signal: NIFTY 0.10% …' },
    tr('2026-11-27', -0.2, -2000), tr('2026-11-27', -0.1, -1000), // two trades one day → one observation (−0.15)
    { date: '2026-11-30', status: 'skip', reason: 'expiry day: no trade' },
    tr('2027-03-30', -0.3, -9000), // FY 2026-27 net −7,000 → carried forward
    tr('2027-04-05', 0.4, 10000), // FY 2027-28: 10,000 − 7,000 = 3,000 taxed at 31.2%
    { date: '2026-11-24', status: 'trade', ret: 9, pnl: 99999, test: true }, // TEST entry: not scored
  ];
  const s = AT.summarise(days, { startedAt: '2026-11-25', niftyAtStart: 20000, niftyNow: 21000, asOf: '2027-04-05' });
  assert.equal(s.n, 5);
  assert.equal(s.won, 2);
  assert.equal(s.winRate, 0.4);
  assert.ok(Math.abs(s.avgRetPct - ((0.5 - 0.2 - 0.1 - 0.3 + 0.4) / 5) * 100) < 1e-9);
  assert.equal(s.totalRs, 3000);
  assert.equal(s.tradeDays, 4);
  const dr = [0.5, -0.15, -0.3, 0.4];
  const m = dr.reduce((a, b) => a + b) / 4;
  const sd = Math.sqrt(dr.reduce((a, b) => a + (b - m) ** 2, 0) / 3);
  assert.ok(Math.abs(s.tDay - m / (sd / 2)) < 1e-12);
  assert.deepEqual(s.skips, { 'no signal': 1, 'expiry day: no trade': 1 });
  assert.equal(s.sessions, 7);
  assert.equal(s.equity, 103000);
  assert.deepEqual(s.afterTax.years.map((y) => y.fy), ['2026-27', '2027-28']);
  assert.ok(Math.abs(s.afterTax.tax - 0.312 * 3000) < 1e-9);
  assert.ok(Math.abs(s.afterTax.pnl - (3000 - 936)) < 1e-9);
  assert.equal(s.curve.at(-1).equity, 103000);
  assert.ok(Math.abs(s.maxDrawdown - 12000 / 105000) < 1e-12, 'peak 105,000 → low 93,000');
  const span = (Date.parse('2027-04-05') - Date.parse('2026-11-25')) / 86400000 + 1;
  assert.equal(s.arbitrage.days, span);
  assert.ok(Math.abs(s.arbitrage.afterTax - 100000 * (1.065 ** (span / 365) - 1) * (1 - 0.208)) < 1e-6);
  assert.ok(Math.abs(s.nifty.rs - 5000) < 1e-9);
  assert.equal(s.verdict, 'Unproven until ≥ 100 trades.');
  assert.equal(AT.fyOf('2027-03-31'), '2026-27');
  assert.equal(AT.fyOf('2027-04-01'), '2027-28');
  // nothing yet
  const z = AT.summarise([]);
  assert.equal(z.n, 0);
  assert.equal(z.totalRs, 0);
  assert.equal(z.tDay, null);
  assert.equal(AT.summarise([], { startedAt: '2026-11-25' }).arbitrage.gross, 0, 'no sessions yet → no arbitrage interest');
});

// ------------------------------------------------------------------ paper walk ---
test('paper record: starts the next session, --date is a TEST entry (not scored), retries no-data days; Breakdown adapter', async () => {
  const file = join(TMP, 'walk.json');
  const at = (d, hm) => new Date(Date.parse(`${d}T${hm}:00+05:30`));
  const bars = {
    '2026-11-23': nifty('2026-11-23', (i, t) => (t <= '12:25' ? 20000 * (1 - 0.01 * (i / 38)) : 19800)), // expiry day
    '2026-11-25': nifty('2026-11-25', (i, t) => (t <= '12:25' ? 20000 * (1 + 0.006 * (i / 38)) : 20100)),
    '2026-11-26': nifty('2026-11-26', (i) => 20000 + i), // no signal
  };
  let optionCalls = 0;
  let groww = 'down';
  const deps = {
    file, getNifty: async (d) => ({ bars: bars[d] || [], source: 'test' }), niftyClose: async () => 20000,
    getOptions: async ({ date }) => {
      optionCalls++;
      if (groww === 'down') throw new Error('Groww offline');
      return { expiry: '2026-12-01', strike: 20100, symbol: 'X', bars: opt(date, { '12:30': 60, '13:30': 40 }, 60) };
    },
  };
  // first run on the 24 Nov 2026 holiday evening: opens the record from Wed 25 Nov, records nothing yet
  let r = await AT.afternoonPaperUpdate({ ...deps, now: at('2026-11-24', '18:00') });
  assert.equal(r.st.startedAt, '2026-11-25');
  assert.equal(r.ran.length, 0);
  // --date 2026-11-23: TEST entry, expiry-day skip, kept apart
  r = await AT.afternoonPaperUpdate({ ...deps, now: at('2026-11-24', '18:05'), date: '2026-11-23' });
  assert.equal(r.ran[0].test, true);
  assert.match(r.ran[0].reason, /^expiry day/);
  assert.equal(r.st.tests.length, 1);
  assert.equal(r.st.days.length, 0);
  assert.equal(r.summary.n, 0);
  // 25 Nov at 15:45: the store is not complete yet (before 16:00) → nothing
  r = await AT.afternoonPaperUpdate({ ...deps, now: at('2026-11-25', '15:45') });
  assert.equal(r.ran.length, 0);
  // 25 Nov evening, Groww down → no option data (retry)
  r = await AT.afternoonPaperUpdate({ ...deps, now: at('2026-11-25', '16:10') });
  assert.equal(r.st.days[0].reason, 'no option data');
  // 26 Nov evening, Groww back: 25 Nov is re-tried and becomes a trade; 26 Nov = no signal
  groww = 'up';
  r = await AT.afternoonPaperUpdate({ ...deps, now: at('2026-11-26', '16:10') });
  assert.deepEqual(r.st.days.map((d) => [d.date, d.status]), [['2026-11-25', 'trade'], ['2026-11-26', 'skip']]);
  assert.equal(r.st.days[0].exit.why, 'stop');
  assert.equal(r.summary.n, 1);
  assert.ok(r.summary.totalRs < 0);
  const calls = optionCalls;
  await AT.afternoonPaperUpdate({ ...deps, now: at('2026-11-26', '20:00') });
  assert.equal(optionCalls, calls, 'recorded days are not run again');
  // Breakdown reads the scored trades only, and validation passes
  const bd = await import('./paper-bot/breakdown.mjs');
  const dir = join(TMP, 'bd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'afternoon-trend-paper.json'), readFileSync(file));
  const data = bd.loadAll({ dir });
  const rows = data.rows.filter((x) => x.strategy === 'afternoon-trend');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entryDate, '2026-11-25');
  assert.equal(data.warnings.filter((w) => /afternoon/.test(w)).length, 0);
  const val = bd.validate(data).filter((x) => x.strategy === 'afternoon-trend');
  assert.ok(val.length && val.every((x) => x.pass), JSON.stringify(val));
  assert.equal(bd.STRATEGIES['afternoon-trend'], 'Afternoon trend (option buying)');
  // the card view
  const v = AT.afternoonView({ file, now: at('2026-11-26', '20:00') });
  assert.equal(v.trades.length, 1);
  assert.equal(v.tests.length, 1);
  assert.equal(v.verdict, 'Unproven until ≥ 100 trades.');
  assert.match(v.research.verdict, /lost both unseen periods; tracked live on paper only to see whether it comes back/);
  assert.match(v.research.sebi, /~91% of F&O traders lose/);
  assert.match(v.replay, /Replayed after the close from 5-minute bars/);
  assert.match(v.note, /Not advice\.$/);
});

test('research block numbers as frozen', () => {
  const R = AT.RESEARCH.rows;
  assert.deepEqual(R.map((x) => x.perTrade), [8.5, -4.1, -2.6]);
  assert.equal(R[0].t, 2.79);
  assert.match(R[2].note, /−1\.5% a year after tax/);
});

// ------------------------------------------------------------------ wiring ---
test('wiring: card in Options & risk after the Spread paper tracker, expiry box, route, run.sh, Not advice', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.ok(html.indexOf('id="spreadPaperCard"') < html.indexOf('id="afternoonCard"') && html.indexOf('id="afternoonCard"') < html.indexOf('id="foRiskCard"'));
  assert.match(html, /<h2>Afternoon trend \(option buying\)/);
  assert.match(html, /\/static\/js\/50-afternoon-trend\.js/);
  const views = readFileSync('static/js/06-home-views.js', 'utf8');
  assert.match(views, /key: 'options', match: \/\^\(Spread paper tracker\|Afternoon trend\|/);
  assert.match(views, /'Spread paper tracker', 'Afternoon trend', 'F&O risk check'/);
  assert.match(readFileSync('static/js/48-expiry.js', 'utf8'), /'afternoonCard'/);
  const js = readFileSync('static/js/50-afternoon-trend.js', 'utf8');
  assert.match(js, /lazy\('Afternoon trend'/);
  assert.match(js, /Not advice/);
  assert.match('/static/js/50-afternoon-trend.js', /^\/static\/(app\.css|js\/\d\d-[a-z-]+\.js)$/);
  assert.match(readFileSync('server.mjs', 'utf8'), /url\.pathname === '\/api\/afternoon-trend'\) return json\(res, 200, afternoonView\(\)\)/);
  const sh = readFileSync('scripts/run.sh', 'utf8');
  const line = sh.split('\n').find((l) => /afternoon-trend\.mjs --paper/.test(l));
  assert.ok(line && /\|\| true$/.test(line.trim()), 'the collect line ends with || true');
  assert.ok(sh.indexOf('collector.mjs --notify') < sh.indexOf('afternoon-trend.mjs --paper') && sh.indexOf('afternoon-trend.mjs --paper') < sh.indexOf('do_refit()'), 'in the evening collect job, after the 5-minute store is saved');
  const mod = readFileSync('paper-bot/afternoon-trend.mjs', 'utf8');
  assert.doesNotMatch(mod, /placeOrder|\/v1\/order|order\/create/i, 'no broker orders');
});
