// Tests for the IPO apply paper record (loop 19) and the "don't buy now" warnings (loop 14): NSE parsers, the expected-value
// and lottery settlement, a full two-evening IPO walk (SME skipped, listing open from the bhav store or NSE's full file),
// and the avoid list (circuit streaks, trade-for-trade, band cuts, ASM diffs, avoid windows). Plus the UI wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const ipo = await import('./paper-bot/ipo-apply.mjs');
const av = await import('./paper-bot/avoid-list.mjs');
const { tradingDaysBetween } = await import('./paper-bot/market-calendar.mjs');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ---------------- IPO apply ----------------
test('IPO: NSE dates (both cases), price bands, mainboard vs SME', () => {
  assert.equal(ipo.ipoDate('20-Nov-2026'), '2026-11-20');
  assert.equal(ipo.ipoDate('04-NOV-2026'), '2026-11-04');
  assert.equal(ipo.ipoDate(null), null);
  assert.deepEqual(ipo.priceBand('Rs.259 to Rs.272'), { lo: 259, hi: 272 });
  assert.deepEqual(ipo.priceBand('    82'), { lo: 82, hi: 82 });
  assert.ok(ipo.isMainboard('Equity'));
  assert.ok(!ipo.isMainboard('SME'));
  assert.ok(!ipo.isMainboard('DEBT') && !ipo.isMainboard('InvIT') && !ipo.isMainboard('REIT'));
});

const detail = ({ retail, lot, band = 'Rs. 100 to Rs. 110 per Equity Share', upd = '18-Nov-2026 19:00:00', period = '14-Nov-2026 to 18-Nov-2026' }) => ({
  activeCat: { updateTime: `Updated as on ${upd}`, dataList: [
    { category: 'Category', noOfShareOffered: 'No.of shares offered/reserved', noOfSharesBid: 'No. of shares bid for', noOfTotalMeant: 'No. of times', srNo: 'Sr.No.' },
    { category: 'Qualified Institutional Buyers(QIBs)', noOfShareOffered: '1000', noOfSharesBid: '50000', noOfTotalMeant: '50', srNo: '1' },
    { category: 'Retail Individual Investors(RIIs)', noOfShareOffered: '3500', noOfSharesBid: '0', noOfTotalMeant: String(retail), srNo: '3' },
    { category: 'Total', noOfShareOffered: '1.0E4', noOfSharesBid: '0', noOfTotalMeant: '20', srNo: null },
  ] },
  issueInfo: { dataList: [{ title: 'Issue Period', value: period }, { title: 'Price Range', value: band }, { title: 'Bid Lot', value: `${lot} Equity Shares and in multiples thereof` }] },
});

test('IPO: ipo-detail → retail subscription, lot, band, as-of time', () => {
  const d = ipo.parseDetail(detail({ retail: 7.88, lot: 55 }));
  assert.equal(d.retailX, 7.88);
  assert.equal(d.lot, 55);
  assert.deepEqual(d.band, { lo: 100, hi: 110 });
  assert.equal(d.retailAsOf, '2026-11-18 19:00');
  assert.equal(d.close, '2026-11-18');
  const empty = ipo.parseDetail({ activeCat: { dataList: [{ category: 'Total', noOfTotalMeant: '0.00' }], updateTime: 'Updated as on null' }, issueInfo: {} });
  assert.equal(empty.retailX, null, 'NSE sometimes has no category data');
  assert.equal(empty.lot, null);
});

test('IPO: seeded draw is deterministic and uniform-ish; settle = p × (gain − sell costs), lottery path, opportunity cost', () => {
  assert.equal(ipo.seededDraw('ZOMATO'), ipo.seededDraw('ZOMATO'));
  assert.notEqual(ipo.seededDraw('ZOMATO'), ipo.seededDraw('NYKAA'));
  const xs = Array.from({ length: 2000 }, (_, i) => ipo.seededDraw(`S${i}`));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  close(xs.reduce((s, x) => s + x, 0) / xs.length, 0.5, 0.03);
  const s = ipo.settle({ symbol: 'AAA', lot: 130, issuePrice: 110, retailX: 4, open: 130, closeDate: '2026-11-18', listingDate: '2026-11-23' });
  close(s.p, 0.25);
  close(s.sellCost, 130 * 130 * 0.0015 + 20);
  close(s.gainIfAllotted, 130 * 20 - (130 * 130 * 0.0015 + 20));
  close(s.expPnl, 0.25 * s.gainIfAllotted);
  assert.equal(s.allotted, s.draw < 0.25);
  assert.equal(s.lotteryPnl, s.allotted ? s.gainIfAllotted : 0);
  assert.equal(s.blockedDays, 5);
  close(s.oppCost, 130 * 110 * (0.065 - 0.027) * 5 / 365);
  const u = ipo.settle({ symbol: 'B', lot: 10, issuePrice: 100, retailX: 0.4, open: 90, closeDate: '2026-11-18', listingDate: '2026-11-23' });
  assert.equal(u.p, 1, 'undersubscribed → always allotted');
  assert.equal(u.allotted, true);
  assert.ok(u.expPnl < 0, 'a listing below the issue price loses');
});

test('IPO paper walk: records mainboard IPOs on their last day (SME skipped), settles at the listing open (store, then full NSE file)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ipo-'));
  const env = { ...process.env };
  process.env.BHAV_EQ_DIR = dir;
  process.env.IPO_APPLY_PAPER_PATH = join(dir, 'ipo.json');
  try {
    writeFileSync(join(dir, '2026-11.json.gz'), gzipSync(JSON.stringify({ '2026-11-23': [['AAA', 130, 140, 125, 135, 110, 9e9]], '2026-11-24': [['AAA', 136, 140, 130, 138, 135, 5e9]] })));
    const cur1 = [
      { companyName: 'AAA Ltd', issueEndDate: '18-Nov-2026', issuePrice: 'Rs.100 to Rs.110', issueStartDate: '14-Nov-2026', series: 'Equity', symbol: 'AAA', status: 'Active' },
      { companyName: 'Small SME', issueEndDate: '18-Nov-2026', issuePrice: 'Rs.50 to Rs.52', issueStartDate: '14-Nov-2026', series: 'SME', symbol: 'SMEX' },
      { companyName: 'CCC Ltd', issueEndDate: '20-Nov-2026', issuePrice: 'Rs.48 to Rs.50', issueStartDate: '18-Nov-2026', series: 'Equity', symbol: 'CCC' },
    ];
    const past2 = [
      { company: 'AAA Ltd', ipoEndDate: '18-NOV-2026', ipoStartDate: '14-NOV-2026', issuePrice: '   110', listingDate: '23-NOV-2026', priceRange: 'Rs.100 to Rs.110', securityType: 'Equity', symbol: 'AAA' },
      { company: 'CCC Ltd', ipoEndDate: '20-NOV-2026', ipoStartDate: '18-NOV-2026', issuePrice: '50', listingDate: '25-NOV-2026', priceRange: 'Rs.48 to Rs.50', securityType: 'Equity', symbol: 'CCC' },
      { companyName: 'Small SME', ipoEndDate: '18-NOV-2026', ipoStartDate: '14-NOV-2026', issuePrice: '52', listingDate: '21-NOV-2026', priceRange: 'Rs.50 to Rs.52', securityType: 'SME', symbol: 'SMEX' },
      { company: 'Old Ltd', ipoEndDate: '02-NOV-2026', ipoStartDate: '29-OCT-2026', issuePrice: '82', listingDate: '05-NOV-2026', priceRange: 'Rs.78 to Rs.82', securityType: 'Equity', symbol: 'OLD' },
    ];
    const details = { AAA: detail({ retail: 4, lot: 130 }), CCC: detail({ retail: 0.5, lot: 50, band: 'Rs. 48 to Rs. 50', upd: '20-Nov-2026 19:00:00', period: '18-Nov-2026 to 20-Nov-2026' }) };
    let lists = [cur1, []];
    const seen = [];
    const fetchFn = async (urls) => urls.map((u) => {
      seen.push(u);
      if (u.endsWith('/ipo-current-issue')) return lists[0];
      if (u.endsWith('/public-past-issues')) return lists[1];
      const m = /symbol=([^&]+)/.exec(u);
      return details[m?.[1]] || null;
    });
    const cmFn = async (d) => (d === '2026-11-25' ? { csv: 'SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL\nCCC,BE,60,62,55,58,58,50,1000,58000\n' } : { missing: true });

    const s1 = await ipo.ipoApplyPaperUpdate({ now: new Date('2026-11-18T13:00:00Z'), fetchFn, cmFn });
    assert.deepEqual(Object.keys(s1.applications), ['AAA'], 'mainboard IPO closing today is applied; SME and later ones are not');
    assert.equal(s1.applications.AAA.lot, 130);
    assert.equal(s1.applications.AAA.issuePrice, 110, 'upper band until the final price is known');
    assert.equal(s1.applications.AAA.final, true, 'subscription after 5 PM on the last day is final');
    assert.deepEqual(s1.openIssues.map((x) => x.symbol), ['AAA', 'CCC']);
    assert.equal(s1.openIssues[1].amount, 50 * 50);
    assert.equal(s1.smeSkipped, 1);
    assert.equal(s1.applications.AAA.status, 'applied');
    assert.ok(s1.applications.AAA.expectedListing > '2026-11-18');
    assert.ok(!seen.some((u) => u.includes('SMEX')), 'no detail fetch for SME issues');

    lists = [[], past2];
    const s2 = await ipo.ipoApplyPaperUpdate({ now: new Date('2026-11-27T14:00:00Z'), fetchFn, cmFn });
    assert.deepEqual(Object.keys(s2.applications).sort(), ['AAA', 'CCC'], 'CCC recorded from the past list; OLD closed before the start');
    const a = s2.applications.AAA;
    const c = s2.applications.CCC;
    assert.equal(c.late, true);
    assert.equal(a.status, 'settled');
    assert.equal(a.open, 130);
    assert.equal(a.priceSource, 'bhav store');
    assert.equal(c.status, 'settled');
    assert.equal(c.open, 60);
    assert.match(c.priceSource, /CM bhavcopy/);
    close(a.expPnl, 0.25 * (130 * 20 - (130 * 130 * 0.0015 + 20)));
    close(c.expPnl, 50 * 10 - (50 * 60 * 0.0015 + 20));
    const t = s2.totals;
    assert.equal(t.settled, 2);
    assert.equal(t.pending, 0);
    close(t.expected.pnl, a.expPnl + c.expPnl);
    close(t.expected.tax, (a.expPnl + c.expPnl) * 0.208);
    close(t.expected.net, t.expected.pnl - t.expected.tax - a.oppCost - c.oppCost);
    close(t.lottery.pnl, a.lotteryPnl + c.lotteryPnl);
    assert.equal(s2.byFy.length, 1);
    assert.equal(s2.byFy[0].fy, '2026–27');
    assert.ok(s2.research.rows.some((r) => r.perYear === 10902));
    assert.equal(JSON.parse(readFileSync(process.env.IPO_APPLY_PAPER_PATH, 'utf8')).totals.settled, 2);
  } finally {
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IPO: an NSE failure is recorded as fetchError, the record is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ipo-'));
  const env = { ...process.env };
  process.env.IPO_APPLY_PAPER_PATH = join(dir, 'ipo.json');
  process.env.BHAV_EQ_DIR = dir;
  try {
    const st = await ipo.ipoApplyPaperUpdate({ now: new Date('2026-11-18T13:00:00Z'), fetchFn: async (urls) => urls.map(() => null), cmFn: async () => null });
    assert.match(st.fetchError, /did not load/);
    assert.equal(st.totals.applications, 0);
  } finally {
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- Don't buy now ----------------
const PD_HEAD = 'MKT,SERIES,SYMBOL,SECURITY,PREV_CL_PR,OPEN_PRICE,HIGH_PRICE,LOW_PRICE,CLOSE_PRICE,NET_TRDVAL,NET_TRDQTY,IND_SEC,CORP_IND,TRADES,HI_52_WK,LO_52_WK';
const pdRow = (ser, sym, o, h, l, c, name = `${sym} LTD`) => `N,${ser},${sym},${name},${o},${o},${h},${l},${c},1000,10, , ,5,${h},${l}`;

test('avoid: PR-zip parsers (Pd with commas in names, bh), band changes, ASM', () => {
  const pd = av.parsePd([PD_HEAD, 'Y, , ,Nifty 50,1,1,1,1,1,1,1,Y, ,1,1,1', pdRow('EQ', 'AAA', 10, 11, 9.5, 11, 'AAA, INDIA LTD'), pdRow('BE', 'BBB', 5, 5.25, 5, 5.25), pdRow('N1', 'BOND', 100, 100, 100, 100), pdRow('EQ', 'XYZ-RE', 1, 1, 1, 1)].join('\n'));
  assert.deepEqual([...pd.keys()].sort(), ['AAA', 'BBB']);
  assert.deepEqual(pd.get('AAA'), { series: 'EQ', o: 10, h: 11, l: 9.5, c: 11 });
  const bh = av.parseBh('SYMBOL,SERIES,SECURITY,HIGH/LOW\nAAA,EQ,AAA, INDIA LTD,H\nBBB,BE,BBB LTD,L\n');
  assert.equal(bh.get('AAA|EQ'), 'H');
  assert.equal(bh.get('BBB|BE'), 'L');
  const band = av.parseBand('Sr. No,Symbol,Series,Security Name,From,To\n1,BALAJIPHOS,ST,BALAJI PHOSPHATES LIMITED,20,5\n2,DCAL,EQ,DISHMAN CARBOGEN AMCIS LIMITED,20,10\n3,ENNATURE,EQ,ENNATURE BIO PHARMA LIMITED,5,20\n');
  assert.deepEqual(band[1], { symbol: 'DCAL', series: 'EQ', from: 20, to: 10 });
  assert.equal(av.parseBand('<html>not found</html>').length, 0);
  const asm = av.parseAsm({ longterm: { data: [{ symbol: 'L1', asmTime: '20-Nov-2026' }, { symbol: 'L1' }] }, shortterm: { data: [{ symbol: 'S1' }] } });
  assert.deepEqual(asm, { long: ['L1'], short: ['S1'], asOf: '20-Nov-2026' });
  assert.equal(av.parseAsm({}), null);
});

test('avoid: session events — exactly the 3rd upper-circuit close, EQ → BE, band cuts only (EQ/BE/BZ)', () => {
  let streaks = {};
  let lastSeries = {};
  const out = [];
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'];
  days.forEach((date, k) => {
    const pd = new Map([['UC', { series: 'EQ', o: 10, h: 12, l: 10, c: 12 }], ['HIT', { series: 'EQ', o: 10, h: 12, l: 10, c: 11.9 }], ['TTT', { series: k < 2 ? 'EQ' : 'BE', o: 5, h: 5, l: 5, c: 5 }]]);
    const bh = new Map([['UC|EQ', 'H'], ['HIT|EQ', 'H']]);
    const band = k === 1 ? [{ symbol: 'CUT', series: 'EQ', from: 20, to: 10 }, { symbol: 'WIDE', series: 'EQ', from: 5, to: 10 }, { symbol: 'SMEX', series: 'ST', from: 20, to: 5 }] : [];
    const r = av.sessionEvents({ date, pd, bh, band, streaks, lastSeries });
    streaks = r.streaks;
    lastSeries = r.lastSeries;
    out.push(...r.events);
  });
  const uc = out.filter((e) => e.code === 'uc3');
  assert.deepEqual(uc.map((e) => [e.symbol, e.date]), [['UC', '2026-11-18']], 'only the 3rd close at the upper band (not the 4th; not a band hit that closed below the high)');
  assert.deepEqual(out.filter((e) => e.code === 't2t').map((e) => [e.symbol, e.date]), [['TTT', '2026-11-18']]);
  assert.deepEqual(out.filter((e) => e.code === 'bandCut').map((e) => e.symbol), ['CUT']);
});

test('avoid: window = the N sessions after the event (holidays skipped)', () => {
  const w = av.avoidWindow('2026-11-19', 5);
  const days = tradingDaysBetween('2026-11-20', '2026-12-31');
  assert.equal(w.since, days[0]);
  assert.equal(w.until, days[4]);
  assert.ok(!days.includes('2026-11-24'), 'Guru Nanak Jayanti is a holiday');
  assert.equal(av.avoidWindow('2026-11-19', 20).until, days[19]);
});

test('avoid: evening walk — first run baselines ASM, later runs flag new ASM entries; unpublished PR is retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avoid-'));
  const env = { ...process.env };
  process.env.AVOID_LIST_PATH = join(dir, 'avoid.json');
  try {
    const day = (d) => {
      const k = ['2026-11-17', '2026-11-18', '2026-11-19'].indexOf(d);
      if (k < 0) return null; // not published yet
      return {
        pd: new Map([['XYZ', { series: 'EQ', o: 10, h: 12, l: 10, c: 12 }], ['TTT', { series: k === 0 ? 'EQ' : 'BZ', o: 5, h: 5, l: 5, c: 5 }]]),
        bh: new Map([['XYZ|EQ', 'H']]),
        band: k === 1 ? [{ symbol: 'BND', series: 'EQ', from: 20, to: 10 }] : [],
        files: ['pdX.csv', 'bhX.csv'],
      };
    };
    let asm = { long: ['L1'], short: ['S1'], asOf: '19-Nov-2026' };
    const s1 = await av.avoidListUpdate({ now: new Date('2026-11-19T14:00:00Z'), fetchDayFn: async (d) => day(d), fetchAsmFn: async () => asm, firstRunSessions: 3 });
    assert.equal(s1.lastDate, '2026-11-19');
    assert.deepEqual(s1.events.map((e) => `${e.symbol}:${e.code}:${e.date}`).sort(), ['BND:bandCut:2026-11-18', 'TTT:t2t:2026-11-18', 'XYZ:uc3:2026-11-19']);
    assert.ok(s1.asm.baselineOnly, 'first ASM list is only the baseline');
    assert.equal(s1.fetchError, null);
    const bnd = s1.events.find((e) => e.symbol === 'BND');
    assert.equal(bnd.since, '2026-11-19');
    assert.equal(bnd.until, av.avoidWindow('2026-11-18', 20).until);

    asm = { long: ['L1', 'L2'], short: ['S2'], asOf: '20-Nov-2026' };
    const s2 = await av.avoidListUpdate({ now: new Date('2026-11-20T14:00:00Z'), fetchDayFn: async (d) => day(d), fetchAsmFn: async () => asm });
    assert.equal(s2.lastDate, '2026-11-19', "today's PR not out yet → retried next evening");
    assert.equal(s2.fetchError, null, 'not an error on the day itself');
    const lt = s2.events.find((e) => e.code === 'ltasm');
    const stm = s2.events.find((e) => e.code === 'stasm');
    assert.equal(lt.symbol, 'L2');
    assert.equal(lt.sessions, 20);
    assert.equal(stm.symbol, 'S2');
    assert.equal(stm.since, '2026-11-20');
    assert.equal(stm.until, av.avoidWindow('2026-11-19', 5).until);
    assert.equal(s2.events.filter((e) => e.code === 'uc3').length, 1, 'no duplicates on a re-run');

    const v = av.avoidListView(new Date('2026-11-20T10:00:00Z'));
    assert.ok(v.bySymbol.XYZ?.length && v.bySymbol.L2?.length && v.bySymbol.S2?.length);
    assert.equal(v.events, undefined, 'full history not served');
    const later = av.avoidListView(new Date(`${av.avoidWindow('2026-11-19', 5).until}T20:00:00Z`)); // 01:30 IST the next day
    assert.ok(!later.bySymbol.S2, 'short-term ASM warning ends after 5 sessions');
    assert.ok(later.bySymbol.L2, 'long-term ASM still on');

    const s3 = await av.avoidListUpdate({ now: new Date('2026-11-23T14:00:00Z'), fetchDayFn: async () => { throw new Error('HTTP 403'); }, fetchAsmFn: async () => { throw new Error('blocked'); } });
    assert.match(s3.fetchError, /HTTP 403/);
    assert.match(s3.fetchError, /ASM: blocked/);
    assert.equal(s3.lastDate, '2026-11-19');
  } finally {
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- UI wiring ----------------
test('UI: sub-tab, cards, scripts, view regexes, server routes, evening job', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /data-sub="ipo"/);
  assert.match(html, /id="ipoOut"/);
  assert.match(html, /id="avoidOut"/);
  assert.match(html, /<h2>Research summary/);
  assert.match(html, /42-ipo-apply\.js/);
  assert.match(html, /43-avoid-list\.js/);
  const views = readFileSync('static/js/06-home-views.js', 'utf8');
  assert.match(views, /ipo: \/\^IPO apply\//);
  assert.match(views, /\|IPO apply\|/);
  assert.match(views, /\|Don't buy now\|/);
  assert.match(views, /\|Research summary\|/);
  const server = readFileSync('server.mjs', 'utf8');
  assert.match(server, /\/api\/ipo-apply/);
  assert.match(server, /\/api\/avoid-list/);
  const sh = readFileSync('scripts/run.sh', 'utf8');
  assert.match(sh, /ipo-apply\.mjs --paper \|\| true/);
  assert.match(sh, /avoid-list\.mjs --paper \|\| true/);
  for (const f of ['static/js/22-momentum-ten.js', 'static/js/24-this-month.js', 'static/js/25-india-mix.js', 'static/js/40-global-mix.js']) assert.match(readFileSync(f, 'utf8'), /avoidMark\(/, f);
  assert.match(readFileSync('static/js/25-india-mix.js', 'utf8'), /LIQUIDBEES &lt; FD\. Not advice\./);
});
