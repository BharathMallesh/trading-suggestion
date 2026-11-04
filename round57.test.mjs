// Tests for the F&O risk check and for retrying late NSE files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r57-'));
process.env.FO_BHAV_DIR = join(TMP, 'fo');
after(() => rmSync(TMP, { recursive: true, force: true }));
const rc = await import('./paper-bot/fo-riskcheck.mjs');
const vp = await import('./paper-bot/vol-premium.mjs');

const chainAt = (spot) => {
  const ch = {};
  for (let k = spot - 3000; k <= spot + 3000; k += spot < 5000 ? 10 : 50) {
    const tv = 120 * Math.exp(-(((k - spot) / 450) ** 2)) + 0.5;
    ch[k] = { CE: Math.max(spot - k, 0) + tv, PE: Math.max(k - spot, 0) + tv, ceVol: 10, peVol: 10 };
  }
  return { date: '2026-11-04', spot, expiry: '2026-11-10', chain: ch };
};
// NIFTY history: mostly quiet weeks, a few crashes
const nifty = [];
let px = 10000;
for (let i = 0; i < 3000; i++) {
  px *= i % 100 === 99 ? 0.94 : 1 + (i % 2 ? 0.003 : -0.0025); // a 6% drop every 100 days: about 5% of weeks
  nifty.push({ date: new Date(Date.UTC(2010, 0, 4) + i * 86400000).toISOString().slice(0, 10), close: px });
}

test('a naked strangle in a small account is blocked; the condor caps the loss; a bought call fits', () => {
  const c = chainAt(20000);
  const s = rc.riskCheck({ strategy: 'strangle', account: 500000, chain: c, niftyRows: nifty });
  assert.equal(s.ok, false);
  assert.equal(s.definedMaxLoss, null, 'a sold strangle has no loss limit');
  assert.ok(s.worstEver < s.bad100 && s.bad100 <= s.bad20);
  const k = rc.riskCheck({ strategy: 'condor', account: 5e7, chain: c, niftyRows: nifty });
  assert.ok(k.definedMaxLoss > 0);
  assert.ok(-k.worstEver <= k.definedMaxLoss + 500, 'never worse than the defined maximum (plus charges)');
  assert.equal(k.ok, true, 'fits a large account');
  const b = rc.riskCheck({ strategy: 'buy-call', account: 500000, chain: c, niftyRows: nifty });
  assert.ok(b.worstEver >= b.premium - 500, 'a bought option can lose only its premium (plus charges)');
  assert.equal(b.ok, true);
  assert.ok(b.fitLots >= 1);
});

test('fitLots is the number of lots whose 1-in-100 week stays within the limit', () => {
  const k = rc.riskCheck({ strategy: 'condor', account: 1e7, lots: 1, chain: chainAt(20000), niftyRows: nifty });
  assert.ok(k.fitLots * -k.bad100 <= k.allowedLoss + 1e-6);
  assert.ok((k.fitLots + 1) * -k.bad100 > k.allowedLoss);
});

test('a recent trading day with no NSE file yet is not cached as missing (retried next time)', async () => {
  const d = new Date(Date.now() + 19800_000 - 86400000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
  const day = d.toISOString().slice(0, 10);
  const notFound = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' });
  const r = await vp.foBhav(day, { fetchFn: notFound });
  assert.equal(r, null);
  assert.equal(existsSync(join(process.env.FO_BHAV_DIR, `${day}.json`)), false, 'no "missing" file written');
});

test('stock option chains: parsed from the NSE file with lot size and the underlying price', () => {
  const head = 'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks';
  const row = (sym, tp, exp, k, opt, close, und, lot, vol = 10) => `2026-11-03,2026-11-03,FO,NSE,${tp},1,,${sym},,${exp},${exp},${k},${opt},x,0,0,0,${close},0,0,${und},0,0,0,${vol},0,0,F1,${lot},`;
  const csv = [head, row('ABC', 'STO', '2026-11-24', 1000, 'CE', 20, 1000, 500), row('ABC', 'STO', '2026-11-24', 1000, 'PE', 18, 1000, 500), row('ABC', 'STO', '2026-11-24', 2000, 'CE', 0.05, 1000, 500), row('NIFTY', 'IDO', '2026-11-09', 24000, 'CE', 30, 23800, 65)].join('\n');
  const s = vp.parseStockChains(csv, '2026-11-03');
  assert.deepEqual(Object.keys(s), ['ABC']);
  assert.equal(s.ABC.lot, 500);
  assert.equal(s.ABC.expiries['2026-11-24'][1000].CE, 20);
  assert.equal(s.ABC.expiries['2026-11-24'][2000], undefined, 'strikes beyond ±25% dropped');
});

test('a stock check uses its own lot and wings as a share of its price', () => {
  const c = { ...chainAt(1000), lot: 500 };
  const r = rc.riskCheck({ symbol: 'ABC', strategy: 'condor', account: 1e8, chain: c, niftyRows: nifty, distancePct: 5, wingPct: 4 });
  assert.equal(r.lot, 500);
  assert.equal(r.legs[2].strike - r.legs[0].strike, 40); // 4% of ₹1,000
  assert.ok(r.tips.some((t) => /results date/.test(t)));
});

test("the Up/Down lean: a stock's label with its 1-month odds; NIFTY by its 200-day average", async () => {
  const odds = (up, avg) => ({ late: { '1m': { up, avg } } });
  const table = { labels: { strong: odds(0.54, 0.018), neutral: odds(0.53, 0.01), weak: odds(0.5, 0.002), all: odds(0.52, 0.01) }, nifty: { above: { '1m': { up: 0.6, avg: 0.006 } }, below: { '1m': { up: 0.72, avg: 0.025 } }, all: { '1m': { up: 0.62 } } } };
  const live = { date: '2026-11-03', momSorted: [0, 0.1, 0.2], rows: [{ symbol: 'ABC', close: 100, label: 'strong', momPct: 0.9, mom: 0.4, above200: true, hi52: 0.97, rsi: 60 }] };
  const s = await rc.leanFor('ABC', { live, table });
  assert.equal(s.label, 'strong');
  assert.equal(s.up1m, 0.54);
  assert.equal(s.baseUp1m, 0.52);
  const n = await rc.leanFor('NIFTY', { niftyRows: nifty, table });
  assert.match(n.label, /200-day/);
  assert.ok(n.up1m === 0.6 || n.up1m === 0.72);
});
