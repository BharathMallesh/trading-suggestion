// Tests for the morning news pick (paper-bot/news-pick.mjs): the candidate pool (liquid top-300 filter, avoid-list
// exclusion, routine-only filings dropped, the watchlist added, the cap), the "no pick today" path, the no-AI path,
// scoring from the pick day's OPEN (not the previous close) vs NIFTY from its open with 0.3% costs, the random control
// (seeded by the date, logged and scored the same way), holiday / late / test-run handling, the scorecard maths, and
// the UI / server / run.sh / plist wiring. All fetchers, the AI and the bhav store are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'np-'));
process.env.NEWS_PICK_PATH = join(dir, 'news-pick.json');
process.env.NEWS_WATCH_PATH = join(dir, 'news-watch.json');
process.env.NEWS_WATCH_STATE_PATH = join(dir, 'news-watch-state.json');
const np = await import('./paper-bot/news-pick.mjs');
const { tradingDaysBetween } = await import('./paper-bot/market-calendar.mjs');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const reset = () => rmSync(process.env.NEWS_PICK_PATH, { force: true });
// Wed 25 Nov 2026 08:40 IST (24 Nov is an NSE holiday, so the previous session is Mon 23 Nov)
const MORNING = new Date('2026-11-25T03:10:00Z');
const ann = (symbol, time, desc, extra = {}) => ({ symbol, company: `${symbol} Ltd`, source: 'NSE', time, title: desc, detail: '', link: null, ...extra });
const ANN = [
  ann('BIGORD', '2026-11-23T18:05:00+05:30', 'Award of Order / Receipt of Order'),
  ann('RESULTCO', '2026-11-24T10:00:00+05:30', 'Outcome of Board Meeting - Financial Results'),
  ann('SMALLCAP', '2026-11-23T19:00:00+05:30', 'Award of Order / Receipt of Order'), // not in the top 300
  ann('BANNED', '2026-11-23T20:00:00+05:30', 'Award of Order / Receipt of Order'), // on the avoid list
  ann('ROUTINE', '2026-11-23T21:00:00+05:30', 'Copy of Newspaper Publication'), // routine only
  ann('OLDNEWS', '2026-11-23T14:00:00+05:30', 'Award of Order / Receipt of Order'), // before the 15:30 close
  ann('RIGHTSCO', '2026-11-24T12:00:00+05:30', 'Rights Issue of equity shares'),
];
const LIQ = { set: new Set(['BIGORD', 'RESULTCO', 'BANNED', 'ROUTINE', 'OLDNEWS', 'RIGHTSCO', 'WATCH1']), valueOf: (s) => ({ BIGORD: 9e9, RESULTCO: 5e9 })[s] || 1e8 };
const fakes = (over = {}) => ({
  now: MORNING,
  clock: () => MORNING,
  pacingMs: 0,
  annFn: async () => ANN,
  liquidityFn: async () => LIQ,
  avoidFn: async () => ({ BANNED: [{ reason: 'price band cut', until: '2026-12-20' }] }),
  holdingsFn: async () => ({ m10: ['WATCH1'], india: [] }),
  newsFn: async (s) => ({ company: `${s} Limited`, headlines: [{ title: `${s} shares rise on order win worth Rs 500 crore`, publisher: 'Mint', time: '2026-11-24T05:00:00.000Z', link: 'https://example.com/a' }] }),
  llmFn: async () => '{"picks":[{"symbol":"RESULTCO","reason":"profit beat","confidence":0.6}]}',
  ...over,
});

test('seeded control index and the news window', () => {
  assert.equal(np.seededIndex('2026-11-25', 7), np.seededIndex('2026-11-25', 7), 'same date, same control');
  const seen = new Set(tradingDaysBetween('2026-01-01', '2026-06-30').map((d) => np.seededIndex(d, 5)));
  assert.equal(seen.size, 5, 'spread over the pool');
  for (const d of ['2026-02-02', '2026-07-07']) assert.ok(np.seededIndex(d, 3) >= 0 && np.seededIndex(d, 3) < 3);
  assert.equal(np.seededIndex('x', 0), -1);
  assert.deepEqual(np.newsWindow('2026-11-25'), { prevSess: '2026-11-23', since: '2026-11-23T15:30:00+05:30' });
  assert.equal(np.newsWindow('2026-11-30').prevSess, '2026-11-27', 'Monday → Friday');
  assert.equal(np.targetSession('2026-11-25', 'day'), '2026-11-25');
  assert.equal(np.targetSession('2026-11-25', 'five'), '2026-12-01', '25, 26, 27, 30 Nov, 1 Dec');
});

test('NSE all-equities parsing keeps the symbol and only NSE links', () => {
  const rows = np.parseAllAnnouncements({ data: [
    { symbol: 'TCS', sm_name: 'Tata Consultancy', desc: 'Award of Order', an_dt: '23-Nov-2026 18:01:02', attchmntFile: 'https://nsearchives.nseindia.com/corporate/x.pdf', attchmntText: 'order  worth' },
    { symbol: 'BAD SYM!', desc: 'x', an_dt: '23-Nov-2026 18:01:02' },
    { symbol: 'INFY', desc: 'no time' },
    { symbol: 'WIPRO', desc: 'Results', exchdisstime: '24-Nov-2026 09:00:00', attchmntFile: 'https://evil.example.com/x.pdf' },
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].symbol, rows[0].company, rows[0].time, rows[0].detail], ['TCS', 'Tata Consultancy', '2026-11-23T18:01:02+05:30', 'order worth']);
  assert.equal(rows[1].link, null);
});

test('liquidity: point-in-time top 300 by traded value of the previous month (fake bhav store)', async () => {
  const days = tradingDaysBetween('2026-10-01', '2026-10-31');
  const series = new Map();
  for (let i = 0; i < 310; i++) series.set(`S${i}`, days.map((d) => ({ date: d, open: 10, close: 10, val: (1000 - i) * 1e6 })));
  let asked = null;
  const liq = await np.liquidity('2026-11-25', async (months) => ((asked = months), series));
  assert.deepEqual(asked, ['2026-10', '2026-11']);
  assert.equal(liq.set.size, 300);
  assert.ok(liq.set.has('S0') && liq.set.has('S299') && !liq.set.has('S300') && !liq.set.has('S309'));
  assert.equal(liq.valueOf('S0'), 1000e6);
});

test('candidate pool: liquid filter, avoid exclusion, routine-only and pre-close news dropped, watchlist, cap', () => {
  const { candidates, excluded } = np.buildPool({ ann: ANN, liquid: LIQ.set, avoid: { BANNED: [{ reason: 'band cut' }] }, watch: [{ symbol: 'WATCH1', from: ['Momentum 10'] }, { symbol: 'BANNED', from: ['added'] }], since: '2026-11-23T15:30:00+05:30', until: '2026-11-25T08:40:59+05:30', valueOf: LIQ.valueOf });
  assert.deepEqual(candidates.map((c) => c.symbol), ['BIGORD', 'RESULTCO', 'RIGHTSCO', 'WATCH1'], 'typed events by priority, then the watchlist');
  assert.equal(excluded.announced, 6, 'OLDNEWS was before the 15:30 close');
  assert.equal(excluded.illiquid, 1);
  assert.deepEqual(excluded.avoid, ['BANNED']);
  assert.equal(excluded.routineOnly, 1);
  assert.deepEqual(candidates[3].from, ['News watch', 'Momentum 10']);
  const many = Array.from({ length: 40 }, (_, i) => ann(`C${i}`, '2026-11-24T10:00:00+05:30', 'Award of Order'));
  const capped = np.buildPool({ ann: many, liquid: new Set(many.map((a) => a.symbol)), since: '2026-11-23T15:30:00+05:30', valueOf: (s) => +s.slice(1) });
  assert.equal(capped.candidates.length, 25);
  assert.equal(capped.excluded.overCap.length, 15);
  assert.equal(capped.candidates[0].symbol, 'C39', 'larger traded value first within an event type');
});

test('parsePicks: only listed, non-avoid symbols, at most 3, "no pick" allowed', () => {
  const cands = [{ symbol: 'A', event: { type: 'results', sub: null } }, { symbol: 'B', event: { type: 'order_win', sub: null } }, { symbol: 'C', event: { type: 'fund_raise', sub: 'rights' } }, { symbol: 'D', event: null }, { symbol: 'E', event: null }];
  const r = np.parsePicks('```json\n{"picks":[{"symbol":"A","reason":"x","confidence":70},{"symbol":"ZZZ"},{"symbol":"C"},{"symbol":"b.ns"},{"symbol":"D"},{"symbol":"E"}]}```', cands);
  assert.deepEqual(r.picks.map((p) => p.symbol), ['A', 'B', 'D']);
  close(r.picks[0].confidence, 0.7);
  assert.deepEqual(r.dropped.map((d) => d.why), ['not in the candidate list', 'a tested avoid event', 'more than 3 picks']);
  const none = np.parsePicks('{"picks":[],"no_pick_reason":"order wins are priced in at the open"}', cands);
  assert.deepEqual(none.picks, []);
  assert.match(none.noPickReason, /priced in/);
  assert.equal(np.parsePicks('nope', cands), null);
  const m = np.pickMessages('2026-11-25', [{ symbol: 'A', company: 'A Ltd', event: { type: 'order_win', sub: null }, items: [{ source: 'NSE', time: '2026-11-23T18:00:00+05:30', title: 'Award of Order', detail: '', event: { type: 'order_win', routine: false } }] }]);
  assert.match(m[0].content, /FADED −1\.7% from open to close/);
  assert.match(m[0].content, /No pick today" is the right answer most days/);
  assert.match(m[1].content, /tested history: order win: −1% next day/);
});

test('morning run: picks, the control from the same pool (seeded), logged once; first real pick stands', async () => {
  reset();
  let prompt = null;
  const r = await np.runNewsPick(fakes({ llmFn: async (msgs) => ((prompt = msgs), '{"picks":[{"symbol":"RESULTCO","reason":"profit beat","confidence":0.6},{"symbol":"RIGHTSCO","reason":"x"}]}') }));
  assert.equal(r.day.test, false);
  assert.deepEqual(r.day.picks.map((p) => p.symbol), ['RESULTCO'], 'the rights issue is dropped as a tested avoid');
  const pool = r.day.candidates.map((c) => c.symbol);
  assert.deepEqual(pool, ['BIGORD', 'RESULTCO', 'RIGHTSCO', 'WATCH1']);
  assert.equal(r.day.control.symbol, pool[np.seededIndex('2026-11-25', pool.length)]);
  assert.ok(r.day.candidates[0].items.some((x) => x.source === 'Mint' && x.link), 'headlines with links');
  assert.match(prompt[1].content, /BIGORD/);
  const st = np.loadNewsPick();
  assert.deepEqual(st.log.map((e) => `${e.kind}:${e.symbol}`), ['pick:RESULTCO', `control:${r.day.control.symbol}`]);
  const again = await np.runNewsPick(fakes({ llmFn: async () => '{"picks":[{"symbol":"BIGORD"}]}' }));
  assert.equal(again.skipped, 'done');
  assert.equal(np.loadNewsPick().log.length, 2);
  // a forced test run the same day neither logs nor replaces the real pick
  const t = await np.runNewsPick(fakes({ force: true, llmFn: async () => '{"picks":[{"symbol":"BIGORD"}]}' }));
  assert.equal(t.day.test, true);
  assert.equal(np.loadNewsPick().log.length, 2);
  assert.equal(np.loadNewsPick().days['2026-11-25'].picks[0].symbol, 'RESULTCO');
  assert.equal(np.notifyText(r), 'News pick today: RESULTCO (unproven — see News watch)');
});

test('"no pick today": nothing logged (no control either)', async () => {
  reset();
  const r = await np.runNewsPick(fakes({ llmFn: async () => '{"picks":[],"no_pick_reason":"nothing concrete; order wins fade after the open"}' }));
  assert.deepEqual(r.day.picks, []);
  assert.equal(r.day.control, null);
  assert.match(r.day.noPickReason, /fade/);
  assert.equal(np.loadNewsPick().log.length, 0);
  assert.equal(np.notifyText(r), 'No news pick today');
});

test('no AI key (missing or 401): no picks, candidates with events, a clear line', async () => {
  for (const msg of ['Missing OPENROUTER_API_KEY. Set your OpenRouter key first', 'OpenRouter rejected the API key (401) — check or replace the key.']) {
    reset();
    const r = await np.runNewsPick(fakes({ llmFn: async () => { throw new Error(msg); } }));
    assert.equal(r.day.ai, 'missing');
    assert.deepEqual(r.day.picks, []);
    assert.equal(r.day.aiNote, np.NO_AI_LINE);
    assert.match(r.day.aiNote, /replace the OpenRouter key/);
    assert.equal(r.day.candidates.length, 4);
    assert.equal(r.day.candidates[0].eventLabel, 'Order win');
    assert.match(r.day.candidates[0].history, /order win/);
    assert.equal(np.loadNewsPick().log.length, 0);
    assert.equal(np.notifyText(r), 'No news pick today (AI key needs replacing)');
  }
  reset();
  const other = await np.runNewsPick(fakes({ llmFn: async () => { throw new Error('OpenRouter HTTP 500: boom'); } }));
  assert.equal(other.day.ai, 'error');
  assert.match(other.day.noPickReason, /AI unavailable/);
});

test('holiday skip, late skip, --force test runs, a run that finishes after 09:15 is not scored', async () => {
  reset();
  let called = false;
  const h = await np.runNewsPick(fakes({ now: new Date('2026-11-24T03:10:00Z'), annFn: async () => ((called = true), []) }));
  assert.equal(h.skipped, 'holiday');
  assert.equal(called, false, 'quiet: no requests on a holiday');
  assert.equal(np.loadNewsPick(), null, 'nothing written');
  assert.equal((await np.runNewsPick(fakes({ now: new Date('2026-11-28T03:10:00Z') }))).skipped, 'holiday', 'Saturday');
  const late = await np.runNewsPick(fakes({ now: new Date('2026-11-25T04:00:00Z') })); // 09:30 IST
  assert.equal(late.skipped, 'late');
  const f = await np.runNewsPick(fakes({ now: new Date('2026-11-24T08:00:00Z'), clock: () => new Date('2026-11-24T08:00:00Z'), force: true }));
  assert.equal(f.day.test, true);
  assert.match(f.day.testReason, /--force/);
  assert.equal(np.loadNewsPick().log.length, 0, 'test runs are never logged for scoring');
  reset();
  const slow = await np.runNewsPick(fakes({ clock: () => new Date('2026-11-25T03:50:00Z') })); // finished 09:20 IST
  assert.equal(slow.day.test, true);
  assert.match(slow.day.testReason, /after the 09:15 open/);
  assert.equal(np.loadNewsPick().log.length, 0);
});

// prices: stock prev close 95, open 100 (a +5.3% gap), close 102 on the pick day; 5th session close 99
const D0 = '2026-11-25';
const pxFake = () => ({
  series: new Map([
    ['AAA', new Map([['2026-11-23', { open: 94, close: 95 }], [D0, { open: 100, close: 102 }], ['2026-11-26', { open: 102, close: 101 }], ['2026-12-01', { open: 100, close: 99 }]])],
    ['CTRL', new Map([[D0, { open: 50, close: 49 }], ['2026-12-01', { open: 50, close: 51 }]])],
  ]),
  nifty: new Map([[D0, { open: 1000, close: 1005 }], ['2026-12-01', { open: 1010, close: 1010 }]]),
});

test('scoring from the OPEN (not the previous close) vs NIFTY from its open, 0.3% costs; control scored the same', () => {
  const log = [
    { id: 'p', date: D0, kind: 'pick', symbol: 'AAA' },
    { id: 'c', date: D0, kind: 'control', symbol: 'CTRL' },
    { id: 't', date: D0, kind: 'pick', symbol: 'AAA', test: true },
  ];
  np.scorePicks(log, pxFake(), D0);
  const d = log[0].score.day;
  assert.equal(d.scored, true);
  close(d.stockPct, 2, 1e-3); // 102 / 100 — from the open; from the previous close it would be +7.37%
  close(d.gapPct, 5.263, 1e-3);
  close(d.niftyPct, 0.5, 1e-3);
  close(d.netPct, 1.7, 1e-3);
  close(d.netVsNiftyPct, 1.2, 1e-3);
  assert.equal(d.hit, true);
  assert.equal(log[0].score.five.scored, false, 'the 5th session (1 Dec) is not complete yet');
  assert.equal(log[0].score.five.target, '2026-12-01');
  assert.equal(log[1].score.day.hit, false); // −2% vs +0.5%
  close(log[1].score.day.netVsNiftyPct, -2.8, 1e-3);
  assert.equal(log[2].score, undefined, 'test runs are never scored');
  np.scorePicks(log, pxFake(), '2026-12-01');
  close(log[0].score.five.stockPct, -1, 1e-3); // 99 / 100
  close(log[0].score.five.niftyPct, 1, 1e-3); // 1010 / 1000
  assert.equal(log[0].score.five.hit, false);
  close(log[1].score.five.stockPct, 2, 1e-3);
  assert.equal(log[1].score.five.hit, true); // +2 − 1 − 0.3 > 0
  // a gap-free hit just above costs: beat NIFTY by 0.2% is a miss after 0.3% costs
  const thin = [{ date: D0, kind: 'pick', symbol: 'X' }];
  np.scorePicks(thin, { series: new Map([['X', new Map([[D0, { open: 100, close: 100.7 }]])]]), nifty: pxFake().nifty }, D0);
  assert.equal(thin[0].score.day.hit, false);
});

test('evening scoring job (fake prices) and the view', async () => {
  reset();
  await np.runNewsPick(fakes());
  const st = np.loadNewsPick();
  const ctrl = st.log.find((e) => e.kind === 'control').symbol;
  let asked = null;
  const r = await np.scoreNewsPick({
    now: new Date('2026-11-25T12:00:00Z'), // 17:30 IST: the 25th is complete
    pricesFn: async (syms, from, need) => {
      asked = { syms, from, need };
      const p = pxFake();
      p.series.set('RESULTCO', p.series.get('AAA'));
      p.series.set(ctrl, p.series.get('CTRL'));
      return p;
    },
  });
  assert.deepEqual(asked.syms.sort(), [...new Set(['RESULTCO', ctrl])].sort());
  assert.equal(asked.from, D0);
  assert.deepEqual(asked.need, [D0]);
  assert.equal(r.scoredNow, 2); // the pick's and the control's same-day scores
  assert.equal(r.scorecard.day.picks.n, 1);
  assert.equal(r.scorecard.day.control.n, 1);
  assert.equal(r.scorecard.five.picks.pending, 1);
  const v = np.newsPickView();
  assert.equal(v.latest.date, D0);
  assert.equal(v.scorecard.pickDays, 1);
  assert.match(v.scorecard.day.verdict, /^unproven — not better than the random control yet \(1 of 100/);
  assert.match(v.disclaimer, /Not advice\.$/);
  assert.equal(v.recent.length, 2);
});

test('scorecard maths: Wilson interval, "unproven" until ≥ 100 picks beat the control with the interval clear of 50%', () => {
  const mk = (kind, n, hits, net = 0.5) => Array.from({ length: n }, (_, i) => ({ date: D0, kind, symbol: `${kind}${i}`, score: { day: { scored: true, hit: i < hits, netPct: i < hits ? net : -net, netVsNiftyPct: i < hits ? net : -net, gapPct: 1 } } }));
  let sc = np.pickScorecard([...mk('pick', 99, 90), ...mk('control', 99, 40)]);
  assert.match(sc.day.verdict, /unproven .*99 of 100/);
  assert.equal(sc.day.proven, false);
  sc = np.pickScorecard([...mk('pick', 120, 80), ...mk('control', 120, 60)]);
  const ci = sc.day.picks.ci;
  close(sc.day.picks.hitRate, 80 / 120);
  close(ci[0], 0.5781, 1e-3); // Wilson 95% for 80/120
  close(ci[1], 0.7449, 1e-3);
  close(sc.day.picks.avgNetPct, (80 * 0.5 - 40 * 0.5) / 120);
  close(sc.day.picks.sumNetPct, 20);
  close(sc.day.picks.avgGapPct, 1);
  assert.match(sc.day.verdict, /^better than the random control so far/);
  assert.equal(sc.day.proven, true);
  sc = np.pickScorecard([...mk('pick', 120, 80), ...mk('control', 120, 90)]);
  assert.match(sc.day.verdict, /^unproven — not better than the random control yet$/, 'interval clear of 50% but the control did better');
  sc = np.pickScorecard([...mk('pick', 120, 66), ...mk('control', 120, 40)]);
  assert.equal(sc.day.proven, false, 'beats the control but the interval includes 50%');
  sc = np.pickScorecard([...mk('pick', 120, 40), ...mk('control', 120, 60)]);
  assert.match(sc.day.verdict, /worse than a coin flip/);
  assert.equal(np.pickScorecard([]).day.picks.n, 0);
});

test('wiring: box above News watch, route, morning mode, evening scoring line, plist (not loaded), nothing else reads the picks', () => {
  const html = readFileSync('index.html', 'utf8');
  const card = html.slice(html.indexOf('id="newsWatchCard"'), html.indexOf('</section>', html.indexOf('id="newsWatchCard"')));
  assert.ok(card.indexOf('id="npOut"') > 0 && card.indexOf('id="npOut"') < card.indexOf('id="nwOut"'), "Today's news pick on top");
  const js = readFileSync('static/js/46-news-watch.js', 'utf8');
  assert.match(js, /api\('\/api\/news-pick'\)/);
  assert.match(js, /Today's news pick/);
  assert.match(js, /Random control/);
  assert.match(js, /fetchError/);
  assert.match(readFileSync('server.mjs', 'utf8'), /'\/api\/news-pick'/);
  const sh = readFileSync('scripts/run.sh', 'utf8');
  const nwLine = sh.indexOf('node paper-bot/news-watch.mjs --run || true');
  const score = sh.indexOf('node paper-bot/news-pick.mjs --score || true');
  assert.ok(nwLine > 0 && score > nwLine, 'evening: scoring after News watch');
  const m = sh.slice(sh.indexOf('  morning)'), sh.indexOf(';;', sh.indexOf('  morning)')));
  assert.match(m, /caffeinate -i -w \$\$ &/);
  assert.match(m, /OPENROUTER_API_KEY="\$\(key trading-research-openrouter\)" node paper-bot\/news-pick\.mjs --run --notify \|\| true/);
  assert.match(sh, /usage: scripts\/run\.sh server\|collect\|monitor\|refit\|backup\|morning/);
  const plist = join(homedir(), 'Library/LaunchAgents/com.trading-research.morning.plist');
  if (existsSync(plist)) {
    const p = readFileSync(plist, 'utf8');
    assert.match(p, /<string>morning<\/string>/);
    assert.match(p, /morning\.log/);
    assert.equal((p.match(/<key>Hour<\/key><integer>8<\/integer><key>Minute<\/key><integer>40<\/integer>/g) || []).length, 5, 'Mon–Fri 08:40');
  }
  // the one exception: the Call / Put tournament (round 78) SCORES the pick's tilt as one forward-tested contestant — read
  // only, it feeds no strategy (its own file is the only thing it writes; checked in round78.test.mjs)
  for (const f of readdirSync('paper-bot').filter((x) => x.endsWith('.mjs') && x !== 'news-pick.mjs' && x !== 'cp-tournament.mjs')) {
    assert.ok(!readFileSync(join('paper-bot', f), 'utf8').includes('news-pick'), `${f} must not read the news picks`);
  }
  const src = readFileSync('paper-bot/news-pick.mjs', 'utf8');
  assert.ok(!/loadNewsWatch|news-watch-state/.test(src), 'the pick does not read the News watch calls');
  for (const f of ['calibration.json', 'prob-calibration.json', 'vol-model.json']) assert.ok(!src.includes(f));
});
