// Tests for News watch (paper-bot/news-watch.mjs): event classification, NSE announcement parsing, the watchlist
// (add / remove), a full evening with fake NSE / news / AI / prices (logging once per evening, one AI reading per day),
// scoring after 1 and 5 sessions vs NIFTY with 0.3% costs, the scorecard maths (Wilson interval, coin-flip verdict),
// graceful failure when NSE / news / AI / prices are down, and the UI / server / evening-job wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'nw-'));
process.env.NEWS_WATCH_PATH = join(dir, 'news-watch.json');
process.env.NEWS_WATCH_STATE_PATH = join(dir, 'news-watch-state.json');
process.env.PREDICTION_LOG_PATH = join(dir, 'prediction-history.json');
const nw = await import('./paper-bot/news-watch.mjs');
const { tradingDaysBetween } = await import('./paper-bot/market-calendar.mjs');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const reset = () => {
  for (const p of [process.env.NEWS_WATCH_PATH, process.env.NEWS_WATCH_STATE_PATH]) rmSync(p, { force: true });
};

test('classification: event types and the tested sub-types', () => {
  const c = (t) => nw.classifyEvent(t);
  assert.equal(c('Award of Order / Receipt of Order').type, 'order_win');
  assert.equal(c('L&T bags mega order worth Rs 5,000 crore').type, 'order_win');
  assert.equal(c('Outcome of Board Meeting - Financial Results for the quarter ended September 30').type, 'results');
  assert.equal(c('Tata Steel Q2 profit jumps 20%').type, 'results');
  assert.deepEqual(c('Rights Issue of equity shares'), { type: 'fund_raise', sub: 'rights', routine: false });
  assert.equal(c('Board approves QIP of Rs 500 crore').sub, 'raise');
  assert.equal(c('Promoter OFS opens today').sub, 'ofs');
  assert.equal(c('Board Meeting Intimation for considering issue of bonus shares').sub, 'bonus_bm');
  assert.equal(c('Record date for stock split').sub, 'bonus_ex');
  assert.equal(c('Interim dividend record date').sub, 'dividend');
  assert.equal(c('Board approves buyback').sub, 'buyback');
  assert.equal(c('Resignation of Chief Financial Officer').type, 'management');
  assert.equal(c('Credit Rating - ICRA reaffirmed').type, 'rating');
  assert.equal(c('Stock placed under ASM framework').type, 'regulatory');
  assert.equal(c('SEBI show-cause notice to the company').type, 'regulatory');
  assert.deepEqual(c("Scheme of Arrangement - Order passed by Hon'ble NCLT"), { type: 'corporate_action', sub: 'restructure', routine: false });
  assert.ok(!nw.FINANCE_WORDS.test('Mdu aka TRP – Cupid Ft Jinger Stone'), 'a song is not company news');
  assert.ok(nw.FINANCE_WORDS.test('Cupid Targets Rs 400 Crore Revenue via V2 Retail Tie-Up'));
  assert.deepEqual(c('Copy of Newspaper Publication pertaining to Un-audited Financial Results'), { type: 'other', sub: null, routine: true });
  assert.equal(c('Closure of Trading Window').routine, true);
  assert.deepEqual(c('Shares fall 3% in a weak market'), { type: 'other', sub: null, routine: false });
});

test('history notes, main event priority and rule calls', () => {
  assert.match(nw.historyFor({ type: 'fund_raise', sub: 'rights' }).text, /4–8% over 20 sessions/);
  assert.match(nw.historyFor({ type: 'order_win', sub: null }).text, /−1% next day on average 2010–22.*no effect 2023–24/);
  assert.equal(nw.historyFor({ type: 'other', sub: null }), null);
  const it = (t) => ({ event: nw.classifyEvent(t) });
  assert.equal(nw.mainEvent([it('Wins order worth Rs 200 crore'), it('Rights issue of equity shares'), it('Closure of trading window')]).sub, 'rights');
  assert.equal(nw.mainEvent([it('Closure of trading window')]), null);
  const r1 = nw.ruleCalls({ type: 'fund_raise', sub: 'rights' });
  assert.equal(r1.five.call, 'DOWN');
  assert.equal(r1.next.call, 'NO CALL');
  assert.equal(nw.ruleCalls({ type: 'order_win', sub: null }).five.call, 'NO CALL');
  assert.equal(nw.ruleCalls(null, [{ reason: 'price band cut', until: '2026-12-20' }]).five.call, 'DOWN');
  assert.equal(nw.normCall('bullish'), 'UP');
  assert.equal(nw.normCall('no_call'), 'NO CALL');
  assert.equal(nw.normCall('maybe'), 'NO CALL');
  const p = nw.parseLlm('```json\n{"summary":"Won an order.","next":{"call":"UP","confidence":70,"reason":"order"},"five":{"call":"NO CALL","confidence":0.9}}\n```');
  assert.equal(p.next.call, 'UP');
  close(p.next.confidence, 0.7);
  assert.equal(p.five.confidence, null);
  assert.equal(nw.parseLlm('no json here'), null);
});

test('NSE announcements: broadcast time in IST, newest first, only NSE attachment links', () => {
  assert.equal(nw.nseTime('13-Nov-2026 17:10:26'), '2026-11-13T17:10:26+05:30');
  assert.equal(nw.nseTime('junk'), null);
  const rows = nw.parseAnnouncements([
    { an_dt: '11-Nov-2026 19:09:42', exchdisstime: '11-Nov-2026 19:09:43', desc: 'Press Release', attchmntText: 'Q2 results', attchmntFile: 'https://nsearchives.nseindia.in/corporate/X.pdf' },
    { an_dt: '13-Nov-2026 17:10:26', desc: 'Award of Order', attchmntText: 'order', attchmntFile: 'https://evil.example.com/x.pdf' },
    { desc: 'no time' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Award of Order');
  assert.equal(rows[0].link, null);
  assert.equal(rows[1].link, 'https://nsearchives.nseindia.in/corporate/X.pdf');
  assert.equal(rows[1].time, '2026-11-11T19:09:43+05:30');
  assert.deepEqual(nw.parseAnnouncements({ nope: 1 }), []);
});

test('watchlist: strategy stocks + added ones, add / remove saved, bad symbols refused', async () => {
  reset();
  assert.deepEqual(nw.addWatchSymbol('tcs.ns'), { symbols: ['TCS'], added: true });
  assert.equal(nw.addWatchSymbol('TCS').added, false);
  assert.throws(() => nw.addWatchSymbol('<script>'), /NSE symbol/);
  nw.addWatchSymbol('CUPID');
  const wl = await nw.watchlist({ holdingsFn: async () => ({ m10: ['CUPID', 'HFCL'], india: ['CUPID.NS'] }) });
  assert.deepEqual(wl.rows, [{ symbol: 'CUPID', from: ['Momentum 10', 'India mix', 'added'] }, { symbol: 'HFCL', from: ['Momentum 10'] }, { symbol: 'TCS', from: ['added'] }]);
  assert.equal(nw.removeWatchSymbol('HFCL').removed, false, 'strategy stocks are not removed here');
  assert.deepEqual(nw.removeWatchSymbol('TCS'), { symbols: ['CUPID'], removed: true });
  assert.deepEqual(JSON.parse(readFileSync(process.env.NEWS_WATCH_PATH, 'utf8')).symbols, ['CUPID']);
  const bad = await nw.watchlist({ holdingsFn: async () => { throw new Error('no paper file'); } });
  assert.match(bad.error, /no paper file/);
  assert.deepEqual(bad.rows.map((r) => r.symbol), ['CUPID']);
});

// ---- a full evening with fakes ----
const EVENING = new Date('2026-11-23T12:00:00Z'); // 17:30 IST, Monday — market closed
const BASE = '2026-11-23';
const days = tradingDaysBetween('2026-11-16', '2026-12-10');
const mkPrices = (stock, nifty) => async () => ({
  series: new Map(Object.entries(stock).map(([s, f]) => [s, new Map(days.map((d, i) => [d, f(d, i)]))])),
  nifty: new Map(days.map((d, i) => [d, nifty(d, i)])),
});
const fakes = (extra = {}) => {
  const calls = { llm: 0 };
  return {
    calls,
    opts: {
      now: EVENING,
      holdingsFn: async () => ({ m10: ['CUPID', 'HFCL'], india: [] }),
      annFn: async (syms, from, to) => {
        assert.equal(from, '2026-11-20', 'last 2 sessions: from the session before the base');
        assert.equal(to, '2026-11-23');
        return new Map(syms.map((s) => [s, { items: s === 'CUPID' ? nw.parseAnnouncements([{ exchdisstime: '23-Nov-2026 18:01:00', desc: 'Award of Order / Receipt of Order', attchmntText: 'Cupid has received an order worth Rs 120 crore' }]) : [] }]));
      },
      newsFn: async (s) => ({ company: `${s} Ltd`, headlines: s === 'HFCL' ? [{ title: 'HFCL board approves rights issue', publisher: 'ET', time: '2026-11-23T10:00:00.000Z', link: 'https://example.com/a' }, { title: 'Top stocks to watch: TCS, HFCL, Infosys', publisher: 'X', time: '2026-11-23T09:00:00.000Z', link: '' }] : [] }),
      llmFn: async (messages) => {
        calls.llm++;
        assert.match(messages[1].content, /Tested history: /);
        return JSON.stringify({ summary: 'Received an order.', next: { call: 'UP', confidence: 0.6, reason: 'order win' }, five: { call: 'DOWN', confidence: 0.55, reason: 'fades' } });
      },
      pricesFn: mkPrices({ CUPID: () => 100, HFCL: () => 50 }, () => 20000),
      avoidFn: async () => ({}),
      ...extra,
    },
  };
};

test('evening run: reads, classifies, calls, logs once at the close; one AI reading per day', async () => {
  reset();
  const f = fakes();
  const st = await nw.runNewsWatch(f.opts);
  const cup = st.latest.CUPID;
  assert.equal(cup.event.type, 'order_win');
  assert.match(cup.history, /order win/);
  assert.equal(cup.source, 'ai');
  assert.equal(cup.next.call, 'UP');
  const hf = st.latest.HFCL;
  assert.equal(hf.event.sub, 'rights');
  assert.equal(hf.items.length, 1, 'market roundup dropped');
  assert.equal(f.calls.llm, 2);
  assert.equal(st.lastRun.logged, 4);
  const c = st.calls.find((x) => x.symbol === 'CUPID' && x.horizon === 1);
  assert.deepEqual({ date: c.date, call: c.call, confidence: c.confidence, price: c.price, nifty: c.nifty, eventType: c.eventType, source: c.source }, { date: BASE, call: 'UP', confidence: 0.6, price: 100, nifty: 20000, eventType: 'order_win', source: 'ai' });
  assert.equal(st.fetchError, null);
  // second run the same evening: no new calls, AI reading reused
  const st2 = await nw.runNewsWatch(f.opts);
  assert.equal(st2.lastRun.logged, 0);
  assert.equal(st2.calls.length, 4);
  assert.equal(f.calls.llm, 2, 'one AI reading per stock per IST day');
});

test('market open: calls shown, not logged', async () => {
  reset();
  const f = fakes({ now: new Date('2026-11-25T06:00:00Z') }); // 11:30 IST Wednesday
  f.opts.annFn = async (syms) => new Map(syms.map((s) => [s, { items: [] }]));
  f.opts.newsFn = async () => ({ headlines: [{ title: 'CUPID wins order worth Rs 50 crore', publisher: 'ET', time: '2026-11-25T05:00:00Z', link: '' }] });
  const st = await nw.runNewsWatch(f.opts);
  assert.equal(st.lastRun.canLog, false);
  assert.equal(st.calls.length, 0);
  assert.equal(st.latest.CUPID.next.call, 'UP');
});

test('scoring after 1 and 5 sessions vs NIFTY, P&L with 0.3% costs', async () => {
  reset();
  await nw.runNewsWatch(fakes().opts); // logs CUPID UP(1)/DOWN(5), HFCL UP(1)/DOWN(5)
  const t1 = nw.sessionAfter(BASE, 1);
  const t5 = nw.sessionAfter(BASE, 5);
  assert.equal(t1, '2026-11-25', '24 Nov is a holiday');
  assert.equal(t5, '2026-12-01');
  // CUPID +2% by t1, +5% by t5; HFCL −1% by t1, −4% by t5; NIFTY +1% by t1, +1% by t5
  const prices = mkPrices(
    { CUPID: (d) => (d <= BASE ? 100 : d < t5 ? 102 : 105), HFCL: (d) => (d <= BASE ? 50 : d < t5 ? 49.5 : 48) },
    (d) => (d <= BASE ? 20000 : 20200),
  );
  const later = fakes({ now: new Date('2026-11-25T12:00:00Z'), pricesFn: prices });
  later.opts.annFn = async (syms) => new Map(syms.map((s) => [s, { items: [] }]));
  later.opts.newsFn = async () => ({ headlines: [] });
  let st = await nw.runNewsWatch(later.opts);
  const one = st.calls.filter((c) => c.horizon === 1 && c.date === BASE);
  const cup = one.find((c) => c.symbol === 'CUPID');
  assert.equal(cup.scored, true);
  assert.equal(cup.hit, true);
  close(cup.stockPct, 2, 1e-3);
  close(cup.niftyPct, 1, 1e-3);
  close(cup.excessPct, 1, 1e-3);
  close(cup.pnlPct, 1.7, 1e-3);
  close(cup.pnlVsNiftyPct, 0.7, 1e-3);
  const hf = one.find((c) => c.symbol === 'HFCL');
  assert.equal(hf.hit, false);
  close(hf.pnlPct, -1.3, 1e-3);
  assert.ok(st.calls.filter((c) => c.horizon === 5).every((c) => !c.scored), '5-session calls wait for their session');
  st = await nw.runNewsWatch({ ...later.opts, now: new Date('2026-12-01T12:00:00Z') });
  const five = st.calls.filter((c) => c.horizon === 5 && c.date === BASE);
  const c5 = five.find((c) => c.symbol === 'CUPID');
  assert.equal(c5.scoredAt, t5);
  assert.equal(c5.hit, false, 'DOWN call, stock beat NIFTY');
  close(c5.pnlPct, -5.3, 1e-3);
  const h5 = five.find((c) => c.symbol === 'HFCL');
  assert.equal(h5.hit, true);
  close(h5.pnlPct, 3.7, 1e-3);
  close(h5.pnlVsNiftyPct, 4.7, 1e-3);
  const sc = nw.scorecard(st.calls.filter((c) => c.date === BASE));
  assert.equal(sc[1].n, 2);
  assert.equal(sc[1].hits, 1);
  assert.equal(sc[5].n, 2);
  close(sc[5].avgPnlPct, (-5.3 + 3.7) / 2, 1e-3);
  assert.match(sc[1].verdict, /not better than a coin flip yet — 2 of 100/);
  assert.equal(sc[1].bySource.ai.n, 2);
  assert.equal(sc[1].byType.order_win.n, 1);
});

test('scorecard maths: Wilson interval and the coin-flip verdict', () => {
  const [lo, hi] = nw.wilson(55, 100);
  close(lo, 0.452, 1e-3);
  close(hi, 0.644, 1e-3);
  assert.equal(nw.wilson(0, 0), null);
  assert.match(nw.verdict(99, nw.wilson(99, 99)), /coin flip yet — 99 of 100/);
  assert.match(nw.verdict(100, nw.wilson(50, 100)), /includes 50%/);
  assert.match(nw.verdict(100, nw.wilson(65, 100)), /better than a coin flip so far/);
  assert.match(nw.verdict(100, nw.wilson(35, 100)), /worse than a coin flip/);
  const calls = [{ horizon: 1, scored: true, hit: true, pnlPct: 1, pnlVsNiftyPct: 0.5, source: 'ai', eventType: 'results' }, { horizon: 1, scored: false }, { horizon: 5, scored: true, hit: false, pnlPct: -2, pnlVsNiftyPct: -1, source: 'rule', eventType: 'fund_raise' }];
  const sc = nw.scorecard(calls);
  assert.equal(sc[1].pending, 1);
  assert.equal(sc[1].hitRate, 1);
  assert.equal(sc[5].totalPnlPct, -2);
});

test('graceful failure: NSE, news, AI and prices down → no crash, fetchError lines, rule calls from avoid warnings', async () => {
  reset();
  const st = await nw.runNewsWatch({
    now: EVENING,
    holdingsFn: async () => ({ m10: ['CUPID', 'BANDCUT'], india: [] }),
    annFn: async () => { throw new Error('HTTP 403'); },
    newsFn: async () => { throw new Error('fetch failed'); },
    llmFn: async () => { throw new Error('Missing OPENROUTER_API_KEY. Set your OpenRouter key first'); },
    pricesFn: async () => { throw new Error('Yahoo down'); },
    avoidFn: async () => ({ BANDCUT: [{ reason: 'price band cut', until: '2026-12-20' }] }),
  });
  assert.match(st.fetchError, /NSE announcements unavailable \(HTTP 403\)/);
  assert.match(st.fetchError, /prices unavailable/);
  assert.match(st.latest.CUPID.errors.join(' '), /headlines unavailable/);
  assert.equal(st.latest.CUPID.five.call, 'NO CALL');
  const bc = st.latest.BANDCUT;
  assert.equal(bc.source, 'rule');
  assert.equal(bc.five.call, 'DOWN');
  assert.deepEqual(bc.warnings, [{ reason: 'price band cut', until: '2026-12-20' }]);
  assert.equal(st.calls.length, 1, 'rule call logged even without a price (filled at scoring)');
  assert.equal(st.calls[0].price, null);
  // the AI missing with news present: news + events still shown, AI note in fetchError
  reset();
  const st2 = await nw.runNewsWatch({ ...fakes().opts, llmFn: async () => { throw new Error('Missing OPENROUTER_API_KEY.'); } });
  assert.match(st2.fetchError, /need OPENROUTER_API_KEY/);
  assert.equal(st2.latest.CUPID.event.type, 'order_win');
  assert.equal(st2.latest.CUPID.items.length, 1);
  assert.equal(st2.latest.CUPID.summary, null);
  assert.equal(st2.latest.HFCL.five.call, 'DOWN', 'rights issue → tested avoid → rule DOWN');
  // a bad AI reply
  reset();
  const st3 = await nw.runNewsWatch({ ...fakes().opts, llmFn: async () => 'sorry' });
  assert.match(st3.latest.CUPID.errors.join(' '), /AI reply could not be read/);
});

test('check now (one stock): keeps the evening summary, reads the stock, logs under the same rules', async () => {
  reset();
  const f = fakes();
  await nw.runNewsWatch(f.opts);
  const st = await nw.runNewsWatch({ ...f.opts, symbols: ['tcs'], refresh: true, llmFn: async () => { throw new Error('Missing OPENROUTER_API_KEY.'); } });
  assert.equal(st.lastRun.stocks, 2, 'evening summary kept');
  assert.deepEqual(st.lastCheck.symbols, ['TCS']);
  assert.ok(st.latest.TCS && st.latest.CUPID && st.latest.HFCL);
  assert.equal(st.fetchError, null);
  assert.equal(st.calls.length, 4);
});

test('view: scorecard on top, every watched stock, not-yet-read stocks, disclaimer', async () => {
  reset();
  await nw.runNewsWatch(fakes().opts);
  nw.addWatchSymbol('TCS');
  const v = await nw.newsWatchView({ holdingsFn: async () => ({ m10: ['CUPID', 'HFCL'], india: [] }) });
  assert.deepEqual(v.stocks.map((s) => s.symbol), ['CUPID', 'HFCL', 'TCS']);
  assert.equal(v.stocks[2].notYet, true);
  assert.ok(v.scorecard[1] && v.scorecard[5]);
  assert.equal(v.scorecard[1].pending, 2);
  assert.match(v.disclaimer, /Not advice\.$/);
  assert.equal(v.recentCalls.length, 4);
});

test('wiring: card, view tab, script, routes, evening job; nothing else reads the calls', () => {
  const html = readFileSync('index.html', 'utf8');
  const card = html.slice(html.indexOf('id="newsWatchCard"'), html.indexOf('</section>', html.indexOf('id="newsWatchCard"')));
  assert.match(card, /<h2>News watch/);
  assert.match(card, /Not advice\.<\/p>/);
  assert.match(html, /<script src="\/static\/js\/46-news-watch\.js"><\/script>/);
  const views = readFileSync('static/js/06-home-views.js', 'utf8');
  assert.match(views, /Don't buy now\|News watch\|/);
  const js = readFileSync('static/js/46-news-watch.js', 'utf8');
  assert.match(js, /lazy\('News watch'/);
  assert.match(js, /fetchError/);
  assert.match(js, /Not advice\./);
  const srv = readFileSync('server.mjs', 'utf8');
  for (const r of ['/api/news-watch', '/api/news-watch/add', '/api/news-watch/remove', '/api/news-watch/check']) assert.ok(srv.includes(`'${r}'`), r);
  const sh = readFileSync('scripts/run.sh', 'utf8');
  const a = sh.indexOf('node paper-bot/avoid-list.mjs --paper');
  const n = sh.indexOf('node paper-bot/news-watch.mjs --run || true');
  assert.ok(a > 0 && n > a, 'evening job: news watch after the NSE files');
  // news-pick imports the helpers, not the calls (round74 checks); the stock Call / Put league (round 80) SCORES the News watch
  // call as one forward-tested contestant — read only, it feeds no strategy (round80.test.mjs checks it writes only its own files)
  for (const f of readdirSync('paper-bot').filter((x) => x.endsWith('.mjs') && x !== 'news-watch.mjs' && x !== 'news-pick.mjs' && x !== 'cp-stocks.mjs')) {
    assert.ok(!readFileSync(join('paper-bot', f), 'utf8').includes('news-watch'), `${f} must not read News watch calls`);
  }
  assert.ok(!existsSync(join(dir, 'nothing')));
});
