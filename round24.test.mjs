// Tests for: weekly scorecard + evening summary across all strategies, strategy
// comparison, and PIN-protected phone access.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r24-'));
process.env.LAN_PATH = join(TMP, 'lan.json');
process.env.VWAP_PAPER_PATH = join(TMP, 'vwap-paper.json');
process.env.ATH_PAPER_PATH = join(TMP, 'ath-paper.json');
process.env.BREAKFAST_PAPER_PATH = join(TMP, 'breakfast-paper.json');
process.env.NIFTY_DIP_PAPER_PATH = join(TMP, 'nifty-dip-paper.json');
process.env.FO_STRANGLE_PATH = join(TMP, 'fo-strangle.json');
process.env.FO_STRANGLE_PAPER_PATH = join(TMP, 'fo-strangle-paper.json');
process.env.FNO_SPREADS_PATH = join(TMP, 'fno-spreads.json');
process.env.RSI_SWING_PATH = join(TMP, 'rsi-swing.json');
process.env.RSI_SWING_PAPER_PATH = join(TMP, 'rsi-swing-paper.json');
process.env.MOMENTUM10_PAPER_PATH = join(TMP, 'm10-paper.json');
process.env.STEADY_MIX_PAPER_PATH = join(TMP, 'steady-mix-paper.json');
process.env.INDIA_MIX_PAPER_PATH = join(TMP, 'india-mix-paper.json');
process.env.IMBALANCE_SWING_PAPER_PATH = join(TMP, 'imbalance-paper.json');
process.env.NIFTY_DIP_PATH = join(TMP, 'nifty-dip.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

test('weekly scorecard: YouTube (₹), swing (R, by exit date) and Breakfast (₹) rows', async () => {
  const w = await import('./paper-bot/weekly.mjs');
  const week = { from: '2026-10-12', to: '2026-10-18', label: '2026-W42' };
  const vwap = { trades: [{ variant: 'video', date: '2026-10-13', net: -1145, gross: -1040, charges: 105, rNet: -1.1, reason: 'stop' }] };
  const swing = { trades: [
    { version: 'improved', entryDate: '2026-09-20', exitDate: '2026-10-14', r: 2.5, retPct: 0.1, open: false, days: 18 },
    { version: 'improved', entryDate: '2026-10-01', exitDate: '2026-10-05', r: -1, retPct: -0.04, open: false, days: 3 },
    { version: 'improved', entryDate: '2026-10-13', exitDate: '2026-10-14', r: 0.4, retPct: 0.02, open: true, days: 1 },
  ] };
  const breakfast = { trades: [{ date: '2026-10-14', side: 'long', net: -5360, gross: -5150, charges: 210, reason: 'stop' }] };
  const rows = w.strategyWeek(vwap, week, { swing, breakfast });
  const sw = rows.find((r) => r.key === 'swing-improved');
  assert.equal(sw.unit, 'R');
  assert.equal(sw.weekTrades, 1, 'open trades and earlier exits excluded');
  assert.equal(sw.weekResult, 2.5);
  assert.equal(sw.totalResult, 1.5);
  assert.match(sw.trust.verdict, /Too early: 2 of 100/);
  const bf = rows.find((r) => r.key === 'breakfast');
  assert.equal(bf.weekResult, -5360);
  assert.equal(rows.find((r) => r.key === 'video').weekNetRs, -1145, 'YouTube rows keep their old fields');
  const md = w.strategyMarkdown(rows, '2026-10-14');
  assert.match(md, /\+2\.5 R/);
  assert.match(md, /−₹5,360/);
  assert.equal(w.earlyVerdict(0), 'No closed trades yet.');
  assert.match(w.earlyVerdict(150, 0.2, 2.4, 'R'), /t ≥ 2/);
});

test('evening summary: one short line per strategy', async () => {
  const { eveningLines } = await import('./paper-bot/evening.mjs');
  const lines = eveningLines('2026-10-14', {
    vwap: { trades: [{ variant: 'video', date: '2026-10-14', symbol: 'TITAN.NS', net: -1200, reason: 'stop' }] },
    breakfast: { trades: [{ date: '2026-10-14', symbol: 'TCS.NS', side: 'long', reason: 'stop', net: -5360 }] },
    swing: { trades: [{ version: 'improved', open: false, exitDate: '2026-10-14', symbol: 'BHEL.NS', r: 3.2, reason: 'chandelier' }] },
    scan: { triggered: [{ symbol: 'LT.NS', setup: 'flag breakout', stop: 3500 }] },
    swingVersion: 'improved',
  });
  assert.equal(lines.length, 4);
  assert.equal(lines[0].short, 'YouTube −₹1,200');
  assert.equal(lines[1].short, 'Breakfast −₹5,360');
  assert.equal(lines[2].short, 'Swing: 1 new signal (LT), exits BHEL +3.2R');
  assert.match(lines[2].detail, /LT flag breakout · buy at the next open on paper · stop ₹3500\.0/);
  const again = eveningLines('2026-10-15', { vwap: { trades: [] }, breakfast: null, swing: null, scan: { triggered: [{ symbol: 'HDFCBANK.NS', setup: 'oversold base breakout', stop: 674.8 }, { symbol: 'TATACONSUM.NS', setup: 'oversold base breakout', stop: 925.6, held: true }] } })[2];
  assert.equal(again.short, 'Swing: 1 new signal (HDFCBANK)', 'a stock already held is not counted as new');
  assert.match(again.detail, /HDFCBANK oversold base breakout · buy at the next open on paper/);
  assert.match(again.detail, /TATACONSUM oversold base breakout again · already held on paper, no new buy/);
  assert.doesNotMatch(again.detail, /TATACONSUM[^·]*buy at the next open/);
  assert.equal(eveningLines('2026-10-15', { vwap: { trades: [] }, breakfast: null, swing: null, dip: null }).map((l) => l.short).join(' · '), 'YouTube: no trade · Breakfast: no trade · Swing: no signals · Dip-buy: no signal');
});

test('strategy comparison: three rows, only a passed test is marked reliable', async () => {
  const { compareStrategies } = await import('./paper-bot/compare.mjs');
  const r = compareStrategies({
    vwap: { sessions: 40, perTrade: { avgNetRs: -268, tStat: -2.3 }, beforeCosts: { avgNetRs: -119 }, widerList: { avgNetRs: -265 } },
    vp: { startedAt: '2026-10-10', byVariant: { video: { trades: 4, winRate: 0.25, totalNetRs: -1678, trust: { verdict: 'Too early' } } } },
    ath: { from: '2010-01-01', to: '2026-10-13', stocks: 192, all: { trades: 788, avgR: 0.06, tStat: 1.5 }, portfolio: { cagr: 0.067, niftyCagr: 0.104 }, afterTax: { strategy: { cagrAfter: 0.05 }, improved: { cagrAfter: 0.087 }, index: { cagrAfter: 0.097 } }, improve: { pick: { adopt: true, test: { avgR: 0.21 }, wideTest: { avgR: 0.19 }, combined: { tStat: 3.4 }, portfolioCagr: 0.108 } } },
    ap: { startedAt: '2026-10-14', trades: [] },
    bf: { sessions: 40, stocks: 200, both: { trades: 74, avgNetRs: -216, tStat: -0.5 }, beforeCosts: { avgNetRs: 7 }, rules: { capital: 100000, leverage: 5, stopPct: 1 } },
    bp: { startedAt: '2026-10-14', trades: [] },
    dip: null,
    dp: null,
  });
  assert.deepEqual(r.rows.map((x) => x.key), ['ath', 'vwap', 'breakfast']);
  assert.equal(r.rows[0].reliable, true);
  assert.match(r.rows[0].money, /10\.8%\/yr vs NIFTY 10\.4% · after tax 8\.7% vs 9\.7%/);
  assert.equal(r.rows[1].reliable, false);
  assert.match(r.rows[2].money, /−₹5,000/);
  assert.match(r.advice, /index fund/);
});

test('phone access: PIN rules, private addresses only, lockout, sessions', async () => {
  const lan = await import('./paper-bot/lan.mjs');
  assert.equal(lan.lanConfig().enabled, false, 'off by default');
  assert.throws(() => lan.saveLan({ enabled: true }), /PIN first/);
  assert.throws(() => lan.saveLan({ pin: '12ab' }), /6 to 12 digits/);
  const c = lan.saveLan({ enabled: true, pin: '482913' });
  assert.equal(c.enabled, true);
  assert.ok(c.hash && c.hash !== '482913', 'only a hash is stored');
  assert.equal(lan.verifyPin('482913'), true);
  assert.equal(lan.verifyPin('482914'), false);
  for (const [ip, ok] of [['192.168.1.5', true], ['::ffff:10.0.0.2', true], ['172.20.1.1', true], ['172.32.0.1', false], ['8.8.8.8', false], ['fe80::1', true], ['127.0.0.1', true]]) assert.equal(lan.isPrivate(ip), ok, ip);
  assert.equal(lan.isLoopback('::ffff:127.0.0.1'), true);
  const now = 1_800_000_000_000;
  for (let k = 0; k < 4; k++) assert.equal(lan.loginAttempt('192.168.1.9', '000000', now).ok, false);
  const fifth = lan.loginAttempt('192.168.1.9', '000000', now);
  assert.equal(fifth.locked, true, '5 wrong tries lock the device');
  assert.equal(lan.loginAttempt('192.168.1.9', '482913', now + 60000).ok, false, 'even the right PIN while locked');
  const okLogin = lan.loginAttempt('192.168.1.9', '482913', now + 16 * 60000);
  assert.equal(okLogin.ok, true);
  assert.match(okLogin.cookie, /HttpOnly; SameSite=Strict/);
  assert.equal(lan.validSession(`x=1; tr_session=${okLogin.token}`, now + 16 * 60000), true);
  assert.equal(lan.validSession(`tr_session=${okLogin.token}`, now + 31 * 86400000), false, 'expires after 30 days');
  const other = lan.loginAttempt('192.168.1.10', '482913', now);
  lan.saveLan({ enabled: true, pin: '777777' });
  assert.equal(lan.validSession(`tr_session=${other.token}`, now), false, 'a new PIN logs every device out');
  assert.match(lan.loginPage('Wrong <PIN>'), /Wrong &lt;PIN&gt;/);
  lan.saveLan({ enabled: false });
  assert.equal(lan.lanConfig().enabled, false);
});

test('survivorship check: only point-in-time members trade; later-gone stocks are counted', async () => {
  const a = await import('./paper-bot/ath-swing.mjs');
  const bh = await import('./paper-bot/bhav-history.mjs');
  // corporate-action adjustment: a 2:1 split halves earlier prices
  const adj = bh.adjust([{ date: 'a', open: 200, high: 202, low: 198, close: 200, prev: 200, val: 1 }, { date: 'b', open: 101, high: 102, low: 99, close: 100, prev: 100, val: 1 }]);
  assert.equal(adj[0].close, 100);
  assert.equal(adj[1].close, 100);
  const parsed = bh.parseCmBhav('SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP\nAAA,EQ,10,11,9,10.5,10.5,10,100,1050,01-JAN-2015\nBBB,N1,1,1,1,1,1,1,1,1,01-JAN-2015\nCCC,BE,5,5,4,4.5,4.5,5,10,45,01-JAN-2015');
  assert.deepEqual(parsed.map((x) => x.sym), ['AAA', 'CCC'], 'EQ and BE kept, other series dropped');
  // universe: previous month's most-traded
  const mk = (val) => Array.from({ length: 40 }, (_, i) => ({ date: `2015-${i < 20 ? '01' : '02'}-${String((i % 20) + 1).padStart(2, '0')}`, open: 1, high: 1, low: 1, close: 1, val }));
  const u = bh.pointInTimeUniverse(new Map([['BIG', mk(100)], ['SMALL', mk(1)]]), 1);
  assert.deepEqual([...u.get('2015-02')], ['BIG']);
  assert.deepEqual([...u.get('2015-03')], ['BIG'], 'next month for live use');
  // a run with a stock that trades and later disappears
  const days = [];
  let d = new Date('2008-01-01T00:00:00Z');
  while (days.length < 900) {
    if (![0, 6].includes(d.getUTCDay())) days.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  const rows = days.map((date, i) => ({ date, open: 100 + i * 0.2, high: 100 + i * 0.2 + 1, low: 100 + i * 0.2 - 1, close: 100 + i * 0.2 + 0.1, val: 1e9 }));
  const gone = rows.slice(0, 700);
  const universe = new Map([...new Set(days.map((x) => x.slice(0, 7)))].map((m) => [m, new Set(['UP'])]));
  const r = a.survivorshipRun(new Map([['UP', rows], ['GONE', gone]]), universe, new Map(), { rulesList: { original: a.RULES } });
  assert.equal(r.laterGone, 0, 'GONE was never in the universe');
  assert.equal(r.stocksEverInUniverse, 1);
  assert.ok(r.results.original.all.trades >= 0);
});
