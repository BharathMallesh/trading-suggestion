// Tests for the expiry-day warning (paper-bot/expiry.mjs) and Today's algo plan (paper-bot/algo-plan.mjs):
//  • the expiry calendar: the weekday rule is read from the expiry dates in the cached exchange files (a fixture with
//    Thursday dates gives Thursday — nothing hard-coded), the holiday shift to the previous trading day (NSE calendar),
//    monthly = the last such weekday, stock-option monthlies;
//  • the warnings appear only on expiry day ('expiry') and the day before ('eve'), the session flips at the 15:30 close,
//    and the evening line only on the evening before an expiry;
//  • the F&O risk check blocks buying a 0DTE option (and only warns for 1DTE / spreads);
//  • the algo plan: a nothing-to-do day, the change day after a month-end with the 5-point band triggered / not
//    triggered (fund orders only when triggered), an IPO last day (lot, ₹, UPI by 5 PM), an avoid-list skip, the
//    capital setting, ticks, the log and its match with the paper records; and the UI / server / run.sh wiring.
// All data are fixtures in a temp dir (no network, no real paper records touched).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r75-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const DATA = join(TMP, 'data');
const DATA_THU = join(TMP, 'data-thu');
process.env.EXPIRY_DATA_DIR = DATA;
process.env.ALGO_PLAN_PATH = join(TMP, 'algo-plan.json');
process.env.BHAV_EQ_DIR = join(TMP, 'no-bhav');
process.env.FO_BHAV_DIR = join(TMP, 'no-fo');

const tuesdays = ['2026-10-06', '2026-10-13', '2026-10-19', '2026-10-27', '2026-11-03', '2026-11-09', '2026-11-17', '2026-11-23', '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29'];
const thursdays = ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24', '2026-12-31'];
function writeData(dir, niftyDates, sensexDates) {
  mkdirSync(join(dir, 'fo-bhav'), { recursive: true });
  mkdirSync(join(dir, 'fo-stocks'), { recursive: true });
  // one NSE file per expiry week, listing the nearest weekly (as the evening job saves them)
  niftyDates.forEach((e, i) => {
    const day = i ? niftyDates[i - 1] : '2026-10-01';
    writeFileSync(join(dir, 'fo-bhav', `${day}.json`), JSON.stringify({ underlying: 26000, expiries: { [e]: { 26000: { CE: 100, PE: 100, ceVol: 1, peVol: 1 } } } }));
  });
  writeFileSync(join(dir, 'bse-sensex-expiries.json'), JSON.stringify({ source: 'fixture', lastDate: '2026-11-20', expiries: sensexDates }));
  writeFileSync(join(dir, 'fo-stocks', '2026-11-20.json'), JSON.stringify({ ABC: { underlying: 100, lot: 500, expiries: { '2026-11-23': {}, '2026-12-29': {}, '2027-01-25': {} } } }));
}
writeData(DATA, tuesdays, thursdays);
writeData(DATA_THU, thursdays.slice(0, 13), thursdays); // NIFTY on Thursdays: the rule must follow the data

const ex = await import('./paper-bot/expiry.mjs');
const rc = await import('./paper-bot/fo-riskcheck.mjs');
const ap = await import('./paper-bot/algo-plan.mjs');
const ist = (date, hhmm) => new Date(Date.parse(`${date}T${hhmm}:00+05:30`));

// ------------------------------------------------------------------ calendar ---
test('weekday rule comes from the data (Tuesday from Tuesday files, Thursday from Thursday files) with the holiday shifts', () => {
  ex.resetExpiryCache();
  const n = ex.deriveWeekdayRule('NIFTY');
  assert.equal(n.weekday, 2);
  assert.equal(n.found, true);
  assert.equal(n.matched, n.weeks);
  // the Monday expiries are explained by the NSE holidays on the Tuesday after them
  assert.deepEqual(n.shifted.map((s) => s.date), ['2026-10-19', '2026-11-09', '2026-11-23']);
  assert.match(n.shifted.find((s) => s.date === '2026-11-23').holiday, /Guru Nanak/);
  assert.equal(ex.deriveWeekdayRule('SENSEX').weekday, 4);
  process.env.EXPIRY_DATA_DIR = DATA_THU;
  ex.resetExpiryCache();
  assert.equal(ex.deriveWeekdayRule('NIFTY').weekday, 4, 'a Thursday data set gives Thursday — nothing hard-coded');
  process.env.EXPIRY_DATA_DIR = DATA;
  ex.resetExpiryCache();
});

test('holiday shift to the previous trading day; monthly = last such weekday; stock options monthly', () => {
  assert.equal(ex.weeklyExpiryFor('2026-11-25', 2), '2026-11-23', 'Tue 24 Nov 2026 is a holiday → Mon 23 Nov');
  assert.equal(ex.weeklyExpiryFor('2026-10-21', 2), '2026-10-19', 'Dussehra 20 Oct → Mon 19 Oct');
  assert.equal(ex.shiftBack('2026-12-25'), '2026-12-24');
  assert.equal(ex.monthlyExpiryFor('2026-11', 2), '2026-11-23');
  assert.equal(ex.monthlyExpiryFor('2026-12', 2), '2026-12-29');
  assert.equal(ex.monthlyExpiryFor('2026-12', 4), '2026-12-31');
  assert.ok(ex.isExpiryDay('2026-11-23', 'NIFTY'));
  assert.ok(!ex.isExpiryDay('2026-11-24', 'NIFTY'), 'a holiday is never an expiry day');
  assert.ok(ex.isExpiryDay('2026-12-01', 'NIFTY'));
  assert.ok(!ex.isExpiryDay('2026-12-02', 'NIFTY'));
  assert.ok(ex.isExpiryDay('2026-12-03', 'SENSEX'));
  assert.ok(ex.isExpiryDay('2026-12-29', 'STOCKS'));
  assert.deepEqual(ex.expiriesOn('2026-12-29').map((x) => `${x.index}:${x.kind}`), ['NIFTY:monthly', 'STOCKS:monthly']);
  assert.ok(ex.isDayBeforeExpiry('2026-11-20', 'NIFTY'), 'Fri 20 Nov is the session before Mon 23 Nov');
  assert.ok(ex.isDayBeforeExpiry('2026-11-30', 'NIFTY'));
  assert.ok(!ex.isDayBeforeExpiry('2026-12-01', 'NIFTY'));
  assert.equal(ex.sessionsToExpiry('2026-12-01', '2026-12-01'), 0);
  assert.equal(ex.sessionsToExpiry('2026-11-30', '2026-12-01'), 1);
  const nx = ex.nextExpiries('2026-11-25');
  assert.equal(nx.find((x) => x.index === 'NIFTY').weekly, '2026-12-01');
  assert.equal(nx.find((x) => x.index === 'SENSEX').weekly, '2026-11-26');
  assert.equal(nx.find((x) => x.index === 'STOCKS').monthly, '2026-12-29');
  const m = ex.monthlyCheck('NIFTY');
  assert.equal(m.matched, m.checked);
});

test('warnings only on expiry day and the day before; the session moves at the 15:30 close; one evening line', () => {
  const lv = (d, t) => ex.expiryStatus(ist(d, t)).level;
  assert.equal(lv('2026-11-30', '10:00'), 'eve', 'Mon before the Tue NIFTY expiry');
  assert.equal(lv('2026-11-30', '16:00'), 'expiry', 'after the close the next session (expiry) counts');
  assert.equal(lv('2026-12-01', '10:00'), 'expiry');
  assert.equal(lv('2026-12-02', '10:00'), 'eve', 'Wed before the Thu SENSEX expiry');
  assert.equal(lv('2026-12-04', '10:00'), 'none', 'Friday: nothing on Fri or Mon');
  assert.equal(lv('2026-12-05', '10:00'), 'eve', 'Saturday → next session Mon 7 Dec, the day before Tue 8 Dec');
  const s = ex.expiryStatus(ist('2026-12-01', '10:00'));
  assert.match(s.title, /Today is NIFTY expiry day/);
  assert.match(s.advice, /Don't buy options today; if you must trade, use limit orders and defined risk/);
  assert.ok(s.lines.some((l) => /59–70%/.test(l) && /75–80%/.test(l)));
  assert.ok(s.lines.some((l) => /98%/.test(l)));
  assert.ok(s.lines.some((l) => /Jane Street/.test(l) && /21 Oct 2026/.test(l)));
  assert.match(ex.eveningExpiryLine('2026-11-30').short, /^Tomorrow is NIFTY expiry — don't buy options$/);
  assert.match(ex.eveningExpiryLine('2026-11-20').short, /Mon, 23 Nov is NIFTY expiry/);
  assert.equal(ex.eveningExpiryLine('2026-12-04'), null);
  assert.equal(ex.eveningExpiryLine('2026-11-24'), null, 'no line on a holiday');
});

// ----------------------------------------------------------- risk check 0DTE ---
const chainAt = (date, expiry, spot = 26000) => {
  const ch = {};
  for (let k = spot - 3000; k <= spot + 3000; k += 50) {
    const tv = 120 * Math.exp(-(((k - spot) / 450) ** 2)) + 0.5;
    ch[k] = { CE: Math.max(spot - k, 0) + tv, PE: Math.max(k - spot, 0) + tv, ceVol: 10, peVol: 10 };
  }
  return { date, spot, expiry, chain: ch };
};
const nifty = [];
let px = 10000;
for (let i = 0; i < 3000; i++) {
  px *= i % 100 === 99 ? 0.94 : 1 + (i % 2 ? 0.003 : -0.0025);
  nifty.push({ date: new Date(Date.UTC(2010, 0, 4) + i * 86400000).toISOString().slice(0, 10), close: px });
}

test('F&O risk check: buying a 0DTE option is blocked; 1DTE and spreads warn; a later expiry is fine', () => {
  const c = chainAt('2026-11-30', '2026-12-01');
  const b = rc.riskCheck({ strategy: 'buy-call', account: 1e7, chain: c, niftyRows: nifty, now: ist('2026-11-30', '19:00') });
  assert.equal(b.dte, 0);
  assert.equal(b.tradeDate, '2026-12-01');
  assert.equal(b.level, 'block');
  assert.equal(b.ok, false);
  assert.equal(b.sized, true, 'blocked for the expiry, not the size');
  assert.match(b.verdict, /^Blocked: this call expires on the day you would buy it/);
  // during expiry day itself, on the previous evening's prices: still the same session → blocked
  assert.equal(rc.riskCheck({ strategy: 'buy-put', account: 1e7, chain: c, niftyRows: nifty, now: ist('2026-12-01', '11:00') }).level, 'block');
  const sp = rc.riskCheck({ strategy: 'call-spread', account: 1e7, chain: c, niftyRows: nifty, wing: 250, now: ist('2026-11-30', '19:00') });
  assert.notEqual(sp.level, 'block', 'a spread is warned, not blocked');
  assert.ok(sp.tips.some((t) => /0DTE/.test(t)));
  const one = rc.riskCheck({ strategy: 'buy-call', account: 1e7, chain: chainAt('2026-11-27', '2026-12-01'), niftyRows: nifty, now: ist('2026-11-27', '19:00') });
  assert.equal(one.dte, 1);
  assert.equal(one.level, 'warn');
  assert.ok(one.ok);
  const fine = rc.riskCheck({ strategy: 'buy-call', account: 1e7, chain: chainAt('2026-12-01', '2026-12-08'), niftyRows: nifty, now: ist('2026-12-01', '19:00') });
  assert.equal(fine.level, 'ok');
  assert.ok(fine.dte >= 2);
  // an oversized trade is still "too big" (the old rule unchanged)
  assert.equal(rc.riskCheck({ strategy: 'strangle', account: 10000, chain: chainAt('2026-12-01', '2026-12-08'), niftyRows: nifty, now: ist('2026-12-01', '19:00') }).level, 'too-big');
});

// ---------------------------------------------------------------- algo plan ---
const mark = (kind, symbol, amount, retPct, last) => ({ kind, symbol, name: symbol, amount, entry: last / (1 + retPct / 100), retPct, last });
// India mix paper: ₹1,00,000 in thirds; drift chosen per test
const indiaPaper = (next50Ret, goldRet) => ({
  startedAt: '2026-10-30', capital: 100000,
  rebalances: [{ monthEnd: '2026-10-30', date: '2026-11-02', putBackToThirds: true, holdings: [] }],
  curve: [{ date: '2026-11-27', value: 100000 }],
  marks: [
    mark('fund', 'JUNIORBEES.NS', 33333, next50Ret, 800), mark('gold', 'GOLDBEES.NS', 33333, goldRet, 100),
    ...['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'JJJ'].map((s) => mark('stock', `${s}.NS`, 3333.3, 0, 500)),
  ],
});
const m10 = { monthEnd: '2026-11-30', list: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'NEW'].map((symbol) => ({ symbol, close: 500 })) };
const CHANGE_DAY = ist('2026-12-01', '08:40'); // first session of December (30 Nov is the November month-end)
const QUIET_DAY = ist('2026-12-09', '08:40'); // a Wednesday: no month-end, no expiry today / tomorrow
const NONE = { level: 'none' };
const FO = { text: 'F&O fixture' };
const base = (over = {}) => ({ fo: FO, state: { settings: {}, ticks: {}, log: {} }, india: indiaPaper(0, 0), m10, ipo: { openIssues: [], applications: {} }, bonus: { upcoming: [], open: [] }, avoid: { events: [] }, indiaTest: null, closes: () => ({}), expiry: NONE, ...over });

test('algo plan: a normal day says "Nothing to do today" plainly', () => {
  const p = ap.algoPlan({ now: QUIET_DAY, ...base() });
  assert.equal(p.date, '2026-12-09');
  assert.equal(p.nothing, true);
  assert.equal(p.actions.length, 0);
  assert.match(p.summary, /^Nothing to do today$/);
  assert.match(p.noBroker, /never places orders/);
  assert.match(p.noBroker, /Groww/);
  assert.ok(p.standing.some((s) => /arbitrage fund/.test(s.text) && /12 months/.test(s.text)));
  assert.match(p.note, /Not advice/);
  // after the close the plan is for the next session
  assert.equal(ap.algoPlan({ now: ist('2026-12-09', '16:00'), ...base() }).date, '2026-12-10');
});

test('algo plan: change day, band TRIGGERED → fund orders back to ⅓ plus the Momentum 10 change', () => {
  const p = ap.algoPlan({ now: CHANGE_DAY, capital: 300000, ...base({ india: indiaPaper(40, -20) }) });
  assert.equal(p.india.bandTriggered, true);
  const by = (s) => p.actions.find((a) => a.symbol === s);
  assert.equal(by('JUNIORBEES').side, 'SELL');
  assert.equal(by('GOLDBEES').side, 'BUY');
  // ₹3,00,000 → ⅓ = ₹1,00,000 per part; JUNIORBEES is worth 3 × 46,666 = ₹1,40,000 at ₹800 → sell 50
  const total = 33333 * 1.4 + 33333 * 0.8 + 33333;
  assert.equal(by('JUNIORBEES').qty, Math.round((100000 - (33333 * 1.4 * 300000) / total) / -800));
  assert.equal(by('JJJ').side, 'SELL');
  assert.equal(by('NEW').side, 'BUY');
  assert.ok(by('NEW').qty > 0);
  assert.match(p.summary, /re-balance/);
  assert.ok(p.actions.every((a) => a.why && a.why.length > 20), 'every action says why');
});

test('algo plan: change day, band NOT triggered → no fund orders, only the Momentum 10 list change', () => {
  const p = ap.algoPlan({ now: CHANGE_DAY, ...base({ india: indiaPaper(2, -1) }) });
  assert.equal(p.india.bandTriggered, false);
  assert.ok(!p.actions.some((a) => a.symbol === 'JUNIORBEES' || a.symbol === 'GOLDBEES'));
  assert.deepEqual(p.actions.map((a) => `${a.side} ${a.symbol}`).sort(), ['BUY NEW', 'SELL JJJ']);
  assert.equal(p.actions.find((a) => a.symbol === 'JJJ').qty, Math.round(((3333.3 / 100000) * 100000) / 500), 'default ₹1,00,000');
  assert.ok(p.info.some((i) => /Band not triggered/.test(i.text)));
  assert.ok(p.info.some((i) => /final/.test(i.text)), 'the final month-end list');
  // the month-end day itself: no orders yet, just the heads-up
  const me = ap.algoPlan({ now: ist('2026-11-30', '08:40'), ...base() });
  assert.equal(me.nothing, true);
  assert.ok(me.info.some((i) => /month-end/.test(i.text)));
});

test('algo plan: IPO last day (lot, rupees, UPI by 5 PM); listing day; bonus/split marked PAPER', () => {
  const ipo = { openIssues: [{ symbol: 'NEWIPO', name: 'New IPO Ltd', open: '2026-12-07', close: '2026-12-09', band: { lo: 129, hi: 136 }, lot: 110, amount: 14960, retailX: 1.5, retailAsOf: '2026-12-08 19:00' }], applications: { OLDIPO: { symbol: 'OLDIPO', status: 'awaiting listing', listingDate: '2026-12-09', lot: 55 } } };
  const bonus = { value: 500000, upcoming: [{ symbol: 'SPLITCO', ex: '2026-12-23', subject: 'Split 10 to 2', entryDate: '2026-12-09', exitDate: '2026-12-22', sessions: 10, late: false }], open: [] };
  const p = ap.algoPlan({ now: QUIET_DAY, ipoBuffer: 20000, ...base({ ipo, bonus, closes: () => ({ SPLITCO: { close: 250, date: '2026-12-08' } }) }) });
  const a = p.actions.find((x) => x.id === 'ipo:NEWIPO:apply');
  assert.equal(a.qty, 110);
  assert.equal(a.amount, 14960);
  assert.match(a.detail, /UPI mandate by 5 PM/);
  assert.ok(p.actions.find((x) => x.id === 'ipo:OLDIPO:sell'));
  const b = p.actions.find((x) => x.kind === 'bonus');
  assert.equal(b.paper, true);
  assert.match(b.title, /^PAPER:/);
  assert.equal(b.qty, 200, '₹50,000 slot / ₹250');
  assert.equal(p.nothing, false);
  assert.match(p.summary, /apply NEWIPO IPO \(₹14,960\), UPI by 5 PM/);
  assert.match(p.summary, /paper-only/);
  // only paper trades → still "nothing to do" for real money
  const q = ap.algoPlan({ now: QUIET_DAY, ...base({ bonus, closes: () => ({}) }) });
  assert.equal(q.nothing, true);
  assert.match(q.summary, /^Nothing to do today \(1 paper-only trade\)/);
});

test('algo plan: a stock on the don\'t-buy-now list is skipped with the reason; the expiry warning is added', () => {
  const avoid = { events: [{ symbol: 'NEW', code: 'bandCut', reason: 'price band cut', date: '2026-11-27', since: '2026-11-30', until: '2026-12-28' }] };
  const p = ap.algoPlan({ now: CHANGE_DAY, ...base({ india: indiaPaper(2, -1), avoid, expiry: ex.expiryStatus(CHANGE_DAY) }) });
  const n = p.actions.find((a) => a.symbol === 'NEW');
  assert.match(n.title, /^SKIP · BUY/);
  assert.match(n.skip, /price band cut \(until 2026-12-28\)/);
  assert.ok(!p.actions.find((a) => a.symbol === 'JJJ').skip, 'sells are never skipped');
  assert.equal(p.warnings[0].level, 'expiry', '1 Dec is a NIFTY expiry');
  assert.match(p.summary, /1 skipped/);
  assert.match(p.summary, /NIFTY expiry today — don't buy options/);
});

test('algo plan: capital setting (saved, validated) scales the quantities; ticks; log matches the paper record', () => {
  assert.equal(ap.savedCapital(), 100000, 'default ₹1,00,000');
  assert.equal(ap.savedIpoBuffer(), 0, 'default IPO buffer ₹0');
  assert.throws(() => ap.saveCapital(500), /between/);
  assert.throws(() => ap.saveSettings({ ipoBuffer: -1 }), /buffer/);
  assert.equal(ap.saveCapital(1000000).capital, 1000000);
  const st = ap.loadAlgoState();
  assert.equal(st.settings.capital, 1000000);
  const big = ap.algoPlan({ now: CHANGE_DAY, ...base({ state: st, india: indiaPaper(2, -1) }) });
  const small = ap.algoPlan({ now: CHANGE_DAY, capital: 500000, ...base({ state: st, india: indiaPaper(2, -1) }) });
  assert.equal(ap.saveSettings({ ipoBuffer: 30000 }).ipoBuffer, 30000);
  assert.equal(ap.loadAlgoState().settings.capital, 1000000, 'saving the buffer keeps the capital');
  assert.equal(big.capital, 1000000);
  assert.equal(big.actions.find((a) => a.symbol === 'JJJ').qty, 2 * small.actions.find((a) => a.symbol === 'JJJ').qty);
  // ticks
  ap.setTick('2026-12-01', 'india:JJJ:SELL', true);
  const t = ap.algoPlan({ now: CHANGE_DAY, ...base({ state: ap.loadAlgoState(), india: indiaPaper(2, -1) }) });
  assert.equal(t.actions.find((a) => a.id === 'india:JJJ:SELL').done, true);
  assert.equal(t.actions.find((a) => a.symbol === 'NEW').done, false);
  assert.throws(() => ap.setTick('bad', 'x'), /Bad date/);
  // log, then compare with the paper portfolio that re-balanced that day (band not triggered)
  ap.logPlan(t);
  const india = { ...indiaPaper(2, -1), rebalances: [{ monthEnd: '2026-11-30', date: '2026-12-01', putBackToThirds: false }] };
  const r = ap.trackRecord({ state: ap.loadAlgoState(), india, ipo: {}, bonus: {}, now: ist('2026-12-02', '10:00') });
  assert.equal(r.days, 1);
  assert.equal(r.checks.length, 1);
  assert.equal(r.matched, 1);
  assert.ok(r.accounts.some((a) => a.card === 'indiaCard'));
  const wrong = ap.trackRecord({ state: ap.loadAlgoState(), india: { ...india, rebalances: [{ monthEnd: '2026-11-30', date: '2026-12-01', putBackToThirds: true }] }, ipo: {}, bonus: {}, now: ist('2026-12-02', '10:00') });
  assert.equal(wrong.matched, 0, 'a different band decision is not a match');
});

// ------------------------------------------------------------------- wiring ---
test('wiring: cards, banner rules, routes, evening line, morning line, run.sh; no broker calls', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.ok(html.indexOf('id="algoPlanCard"') > 0 && html.indexOf('id="algoPlanCard"') < html.indexOf('id="monthCard"'), 'algo plan above Do this month');
  assert.ok(html.indexOf('id="expiryBanner"') > 0 && html.indexOf('id="expiryBanner"') < html.indexOf('<main>'));
  assert.match(html, /47-algo-plan\.js/);
  assert.match(html, /48-expiry\.js/);
  assert.match(html, /<b>Expiry day<\/b>/);
  const views = readFileSync('static/js/06-home-views.js', 'utf8');
  assert.match(views, /const ORDER = \["Today's algo plan", 'Trade today\?'/);
  assert.match(views, /expiryShow\(v\)/);
  const xp = readFileSync('static/js/48-expiry.js', 'utf8');
  assert.match(xp, /s\.level !== 'none' \? \['home', 'options', 'foplan'\]\.includes\(v\) : \['options', 'foplan'\]\.includes\(v\)/, 'Home only on expiry day / the day before');
  for (const id of ['foRiskCard', 'foBudgetCard', 'spreadPaperCard', 'strikeCard', 'foPlanCard']) assert.match(xp, new RegExp(id));
  assert.match(xp, /Not advice/);
  const apjs = readFileSync('static/js/47-algo-plan.js', 'utf8');
  assert.match(apjs, /\/api\/algo-plan\/tick/);
  assert.match(apjs, /noBroker/);
  assert.match(readFileSync('static/js/31-fo-riskcheck.js', 'utf8'), /r\.level === 'block'/);
  assert.match(readFileSync('static/js/32-fo-budget.js', 'utf8'), /0DTE/);
  const srv = readFileSync('server.mjs', 'utf8');
  for (const r of ["'/api/expiry'", "'/api/algo-plan'", "'/api/algo-plan/tick'", "'/api/algo-plan/settings'"]) assert.ok(srv.includes(r), r);
  assert.match(readFileSync('paper-bot/evening.mjs', 'utf8'), /eveningExpiryLine\(date\)/);
  assert.match(readFileSync('paper-bot/news-pick.mjs', 'utf8'), /\$\{await algoPlanLine\(\)\}\$\{notifyText\(r\)\}/);
  const sh = readFileSync('scripts/run.sh', 'utf8');
  assert.ok(sh.indexOf('node paper-bot/algo-plan.mjs --today --log') > 0 && sh.indexOf('node paper-bot/algo-plan.mjs --today --log') < sh.indexOf('node paper-bot/evening.mjs --notify'));
  for (const f of ['paper-bot/algo-plan.mjs', 'paper-bot/expiry.mjs']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/groww-data|placeOrder|api\.groww|fetch\(/.test(src), `${f} calls no broker or network`);
    for (const j of ['calibration.json', 'prob-calibration.json', 'vol-model.json']) assert.ok(!src.includes(j));
  }
  assert.ok(existsSync('paper-bot/data/bse-sensex-expiries.json'));
});

test('₹1 lakh design: whole-share sizing flags, charges as a share of each order, small legs, IPO buffer, bonus and F&O notes', () => {
  // sizing: ₹1,00,000 → stock third ₹33,333 → ₹3,333 a slot
  const ten = ap.stockSizing([{ symbol: 'CHEAP', close: 330 }, { symbol: 'DEAR', close: 10500 }, { symbol: 'ODD', close: 2400 }, ...Array.from({ length: 7 }, (_, i) => ({ symbol: `S${i}`, close: 100 }))], 33333.3, 100000);
  const by = (s) => ten.find((x) => x.symbol === s);
  assert.equal(by('CHEAP').shares, 10);
  assert.deepEqual(by('CHEAP').flags, []);
  assert.equal(by('DEAR').shares, 0);
  assert.match(by('DEAR').flags[0], /costs more than its ₹3,333 slot/);
  assert.equal(by('ODD').shares, 1);
  assert.deepEqual(by('ODD').flags, [], '₹2,400 vs ₹3,333 = −0.9 points: under the 1-point flag');
  const r = ap.stockSizing([{ symbol: 'R', close: 2200 }, ...Array.from({ length: 9 }, (_, i) => ({ symbol: `S${i}`, close: 100 }))], 33333.3, 100000)[0];
  assert.equal(r.shares, 2, '₹3,333 / ₹2,200 rounds to 2 shares = ₹4,400');
  assert.match(r.flags[0], /whole shares move its weight by \+1\.1 points/);
  // charges: a small stock leg vs an ETF order
  const c = ap.chargesFor('SELL', 800);
  assert.equal(c.small, true);
  assert.ok(c.chargesPct > 2, 'DP charge on an ₹800 sell is > 2%');
  assert.ok(c.withFlatPct > c.chargesPct);
  assert.ok(ap.chargesFor('BUY', 33000, true).chargesPct < 0.1);
  // change-day orders carry charges and size flags
  const p = ap.algoPlan({ now: CHANGE_DAY, ...base({ india: indiaPaper(2, -1) }) });
  const sell = p.actions.find((a) => a.symbol === 'JJJ');
  assert.ok(sell.charges > 0 && sell.chargesPct > 0);
  assert.match(sell.detail, /% of the order/);
  assert.ok(p.sizing.length === 10);
  // IPO with no buffer (the ₹1 lakh default): shown, but skipped for lack of cash outside India mix
  const ipo = { openIssues: [{ symbol: 'NEWIPO', name: 'New IPO Ltd', close: '2026-12-09', band: { hi: 136 }, lot: 110, amount: 14960 }, { symbol: 'TWOIPO', name: 'Two Ltd', close: '2026-12-09', band: { hi: 300 }, lot: 50, amount: 15000 }], applications: {} };
  const none = ap.algoPlan({ now: QUIET_DAY, ...base({ ipo }) });
  assert.ok(none.actions.every((a) => a.skip && /no separate cash/.test(a.skip)));
  assert.equal(none.nothing, true);
  assert.ok(none.standing.some((x) => /needs a separate small cash buffer/.test(x.text)));
  const one = ap.algoPlan({ now: QUIET_DAY, ipoBuffer: 20000, ...base({ ipo }) });
  assert.equal(one.settings.ipoSlots, 1);
  assert.equal(one.actions.filter((a) => !a.skip).length, 1, '₹20,000 buffer blocks one application at a time');
  assert.match(one.actions.find((a) => a.skip).skip, /buffer ₹20,000 has ₹5,040 left/);
  // bonus / idle cash / F&O notes
  assert.ok(none.standing.some((x) => /not feasible at ₹1,00,000 except as paper/.test(x.text) && /₹50,000 slots × 10/.test(x.text)));
  assert.ok(none.standing.some((x) => /1\.25 lakh/.test(x.text) && /not a concern/.test(x.text)));
  const fo = ap.foSizes(100000, { chain: { spot: 25500, date: '2026-11-23' }, stocksDir: join(DATA, 'fo-stocks') });
  assert.ok(Math.abs(fo.nifty.notional - 25500 * 65) < 1);
  assert.ok(Math.abs(fo.nifty.margin - 25500 * 65 * 0.15) < 1);
  assert.match(fo.text, /impossible/);
  assert.match(fo.text, /buying options is the only F&O possible/);
  assert.match(fo.text, /expiry-day warning still applies/);
});
