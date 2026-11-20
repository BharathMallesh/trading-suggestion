#!/usr/bin/env node
// IPO apply (library + CLI) — PAPER ONLY. From the Nov 2026 loop-19 study (NSE IPOs 2012 → Nov 2026). Frozen rule:
//  • Apply for the MINIMUM retail lot in EVERY mainboard IPO (SME issues excluded) on its last bidding day.
//  • If allotted, sell at the listing-day OPEN.
// Paper accounting by expected value: allotment chance p = min(1, 1 / final retail-category subscription);
// expected P&L = p × lot × (listing open − issue price) − p × sell costs (0.15% of the sale + ₹20 DP charge).
// Tax: STCG 20% + 4% cess on each financial year's positive net (losses offset within the year).
// A seeded "lottery" draw per IPO (seed = symbol) shows one realistic path next to the expected value.
// Benchmark: the blocked amount would otherwise sit in an arbitrage fund (~6.5% a year); while blocked (close → listing)
// it still earns savings interest (2.7%) — the small difference is shown as the opportunity cost.
// Data: NSE ipo-current-issue, public-past-issues and ipo-detail (category-wise subscription) via curl (NSE refuses
// Node's fetch over HTTP/2); listing-day open from the app's NSE bhav store, else NSE's full daily CM bhavcopy file
// (the store only keeps the ~300 most-traded stocks; every listing is in the full file). Not advice.
//
//   node paper-bot/ipo-apply.mjs --paper

import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { writeJsonAtomic } from '../util.mjs';
import { downloadCm, parseCmBhav } from './bhav-history.mjs';
import { tradingDaysBetween } from './market-calendar.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const BHAV = () => process.env.BHAV_EQ_DIR || join(HERE, 'data', 'bhav-eq');
const PAPER = () => process.env.IPO_APPLY_PAPER_PATH || join(HERE, 'data', 'ipo-apply-paper.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const API = 'https://www.nseindia.com/api';

export const IPO = { sellCostPct: 0.15, dpCharge: 20, taxRate: 0.208, arbYield: 0.065, savingsYield: 0.027, listingLagSessions: 3, maxDetailFetches: 15 };
export const RESEARCH = {
  rows: [
    { period: 'BUILD 2012–2019', perYear: 2209, note: 'rule designed here' },
    { period: 'CHECK 2020–2022', perYear: 4094, note: 'frozen, run once' },
    { period: 'TEST Jan 2023 → Nov 2026', perYear: 10902, note: 'frozen, run once · 2.2 pt a year on ₹5 lakh · Monte Carlo p5–p95 ₹4,300–₹18,200 · t 3.06' },
  ],
  exBest10: 5786,
  t: 3.06,
  appsPerYear: 93,
  cautions: [
    'The TEST gain is uneven: 2023–24 ≈ ₹17,400 a year, but 2025 → Nov 2026 only ≈ ₹3,500 a year.',
    'Without its 10 best IPOs the TEST gain falls to ≈ ₹5,786 a year.',
    'It is a fixed number of rupees per PAN (one minimum lot each time), not a % of your money — about 93 applications a year.',
    'Filters (only ≥ 3× retail subscription, only small issues) and applying for the maximum ₹2 lakh did worse.',
    'After tax and compared with leaving the money in an arbitrage fund (≈ 6.5% a year).',
  ],
};

const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
/** "20-Nov-2026" / "04-NOV-2026" → "2026-11-20" (null when it isn't a date). */
export const ipoDate = (s) => {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(s || '').trim());
  return m && MON[m[2].toUpperCase()] ? `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}` : null;
};
const num = (x) => {
  const v = parseFloat(String(x ?? '').replace(/[",\s]/g, ''));
  return Number.isFinite(v) ? v : null;
};
/** "Rs.259 to Rs.272" → { lo: 259, hi: 272 }; "82" → { lo: 82, hi: 82 }. */
export function priceBand(s) {
  const xs = (String(s || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((x) => x > 0);
  return xs.length ? { lo: Math.min(...xs), hi: Math.max(...xs) } : null;
}
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const fyOf = (d) => {
  const [y, m] = d.split('-').map(Number);
  return m >= 4 ? y : y - 1;
};

/** Mainboard only: NSE marks SME issues "SME"; debt, REIT and InvIT issues are not shares. */
export const isMainboard = (type) => /^(equity|eq)$/i.test(String(type || '').trim());

/** One row of ipo-current-issue → issue (or null). */
export function parseCurrent(r) {
  if (!r?.symbol) return null;
  const band = priceBand(r.issuePrice);
  return { symbol: String(r.symbol).trim(), name: r.companyName || r.symbol, type: r.series, mainboard: isMainboard(r.series), open: ipoDate(r.issueStartDate), close: ipoDate(r.issueEndDate), band, status: r.status || null };
}
/** One row of public-past-issues → issue (or null). */
export function parsePast(r) {
  if (!r?.symbol) return null;
  return { symbol: String(r.symbol).trim(), name: r.company || r.companyName || r.symbol, type: r.securityType, mainboard: isMainboard(r.securityType), open: ipoDate(r.ipoStartDate), close: ipoDate(r.ipoEndDate), listing: ipoDate(r.listingDate), issuePrice: num(r.issuePrice), band: priceBand(r.priceRange) };
}
/** ipo-detail JSON → { retailX, retailAsOf, lot, band, close }. Retail = the "Retail Individual Investors" row (all exchanges). */
export function parseDetail(j) {
  const out = { retailX: null, retailAsOf: null, lot: null, band: null, close: null };
  if (!j || typeof j !== 'object') return out;
  for (const row of j.activeCat?.dataList || []) {
    if (!/retail/i.test(row.category || '')) continue;
    let x = num(row.noOfTotalMeant);
    if (x == null && num(row.noOfShareOffered) > 0 && num(row.noOfSharesBid) != null) x = num(row.noOfSharesBid) / num(row.noOfShareOffered);
    if (x != null) { out.retailX = x; break; }
  }
  const upd = /(\d{1,2}-[A-Za-z]{3}-\d{4})(?:\s+(\d{1,2}:\d{2}))?/.exec(j.activeCat?.updateTime || '');
  if (upd) out.retailAsOf = `${ipoDate(upd[1])}${upd[2] ? ` ${upd[2]}` : ''}`;
  for (const it of j.issueInfo?.dataList || []) {
    const t = String(it.title || '');
    const v = String(it.value ?? '');
    if (out.lot == null && /bid lot|market lot|minimum order|lot size/i.test(t)) {
      const m = /([\d,]+)/.exec(v);
      if (m) out.lot = num(m[1]);
    }
    if (!out.band && /^price range/i.test(t.trim())) out.band = priceBand(v);
    if (!out.close && /^issue period/i.test(t.trim())) out.close = ipoDate(v.split(/\s+to\s+/i)[1]);
  }
  return out;
}

/** Deterministic uniform [0, 1) from a string (FNV-1a hash → mulberry32). */
export function seededDraw(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let t = (h + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Settle one application at the listing-day open. */
export function settle({ symbol, lot, issuePrice, retailX, open, closeDate, listingDate, R = IPO }) {
  const p = Math.min(1, 1 / Math.max(retailX, 1e-9));
  const sale = lot * open;
  const sellCost = sale * (R.sellCostPct / 100) + R.dpCharge;
  const gainIfAllotted = lot * (open - issuePrice) - sellCost;
  const expPnl = p * gainIfAllotted;
  const draw = seededDraw(symbol);
  const allotted = draw < p;
  const blockedDays = Math.max(0, daysBetween(closeDate, listingDate));
  const oppCost = lot * issuePrice * (R.arbYield - R.savingsYield) * blockedDays / 365;
  return { open, p, gainIfAllotted, sellCost, expPnl, draw, allotted, lotteryPnl: allotted ? gainIfAllotted : 0, blockedDays, oppCost };
}

/** NSE API JSON via curl (Node's fetch is refused over HTTP/2). Returns parsed JSON per URL, null for a failed one. */
export async function nseJson(urls) {
  const dir = mkdtempSync(join(tmpdir(), 'nse-'));
  const jar = join(dir, 'cj.txt');
  const base = ['-s', '-L', '--compressed', '--max-time', '60', '-b', jar, '-c', jar, '-A', UA, '-H', 'Accept-Language: en-US,en;q=0.9', '-H', 'Referer: https://www.nseindia.com/market-data/all-upcoming-issues-ipo'];
  try {
    await run('curl', [...base, '-H', 'Accept: text/html,*/*;q=0.8', '-o', '/dev/null', 'https://www.nseindia.com/']).catch(() => {});
    const out = [];
    for (const u of urls) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const { stdout } = await run('curl', [...base, '-H', 'Accept: */*', u], { maxBuffer: 50 * 1024 * 1024 });
        out.push(JSON.parse(stdout));
      } catch {
        out.push(null);
      }
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Listing-day open from the bhav store (first session the symbol appears on/after the listing date). */
function storeOpen(symbol, listing) {
  if (!existsSync(BHAV())) return null;
  const files = readdirSync(BHAV()).filter((x) => /^\d{4}-\d{2}\.json\.gz$/.test(x) && x.slice(0, 7) >= listing.slice(0, 7)).sort().slice(0, 2);
  for (const f of files) {
    const m = JSON.parse(gunzipSync(readFileSync(join(BHAV(), f))).toString('utf8'));
    for (const d of Object.keys(m).sort()) {
      if (d < listing) continue;
      const r = m[d].find((x) => x[0] === symbol);
      if (r && r[1] > 0) return { open: r[1], date: d, source: 'bhav store' };
      if (d > addDays(listing, 7)) return null;
    }
  }
  return null;
}
/** Listing-day open from NSE's full CM bhavcopy for that day (every listed stock, EQ/BE/BZ). */
async function fullFileOpen(symbol, listing, cmFn) {
  const got = await cmFn(listing).catch(() => null);
  if (!got?.csv) return null;
  const r = parseCmBhav(got.csv).find((x) => x.sym === symbol);
  return r ? { open: r.o, date: listing, source: `NSE CM bhavcopy (${r.series})` } : null;
}

export const loadIpoApplyPaper = () => {
  try {
    return JSON.parse(readFileSync(PAPER(), 'utf8'));
  } catch {
    return null;
  }
};

/** Daily update: refresh NSE's lists, record applications on each mainboard IPO's last day, settle listed ones. */
export async function ipoApplyPaperUpdate({ now = new Date(), fetchFn = nseJson, cmFn = downloadCm, R = IPO } = {}) {
  const today = new Date(now.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  let st = loadIpoApplyPaper();
  if (!st) st = { startedAt: today, applications: {}, openIssues: [], smeSkipped: 0, fetchError: null };
  const apps = st.applications;

  let current = [];
  let past = [];
  try {
    const [cur, pst] = await fetchFn([`${API}/ipo-current-issue`, `${API}/public-past-issues`]);
    if (!Array.isArray(cur) && !Array.isArray(pst)) throw new Error('NSE IPO lists did not load (blocked or changed)');
    current = (Array.isArray(cur) ? cur : []).map(parseCurrent).filter((x) => x?.close);
    past = (Array.isArray(pst) ? pst : []).map(parsePast).filter((x) => x?.close);
    st.fetchError = null;
  } catch (err) {
    st.fetchError = `${today}: ${err.message}`;
  }
  const pastBy = new Map(past.filter((x) => x.mainboard).map((x) => [x.symbol, x]));
  st.smeSkipped = current.filter((x) => !x.mainboard).length;
  if (current.length || past.length) {
    // record: every mainboard IPO whose last bidding day is on/after the start and on/before today
    for (const x of [...current, ...past]) {
      if (!x.mainboard || x.close < st.startedAt || x.close > today || apps[x.symbol]) continue;
      apps[x.symbol] = { symbol: x.symbol, name: x.name, openDate: x.open, closeDate: x.close, appliedOn: x.close, recordedOn: today, late: today > x.close, band: x.band, issuePrice: x.issuePrice ?? x.band?.hi ?? null, lot: null, retailX: null, retailAsOf: null, final: false, listingDate: null, status: 'applied' };
    }
    // listing dates and final issue prices
    for (const a of Object.values(apps)) {
      const p = pastBy.get(a.symbol);
      if (!p) continue;
      if (p.listing) a.listingDate = p.listing;
      if (p.issuePrice > 0) a.issuePrice = p.issuePrice;
    }
  }
  // details: open mainboard issues (for the apply list) and applications whose final subscription isn't in yet
  const openMain = current.filter((x) => x.mainboard && x.close >= today);
  const need = [...new Set([...Object.values(apps).filter((a) => !['settled', 'no listing', 'no data'].includes(a.status) && (!a.final || a.lot == null)).map((a) => a.symbol), ...openMain.map((x) => x.symbol)])].slice(0, R.maxDetailFetches);
  const details = new Map();
  if (need.length && (current.length || past.length)) {
    try {
      const js = await fetchFn(need.map((s) => `${API}/ipo-detail?symbol=${encodeURIComponent(s)}&series=EQ`));
      need.forEach((s, i) => js[i] && details.set(s, parseDetail(js[i])));
    } catch (err) {
      st.fetchError = `${today}: details: ${err.message}`;
    }
  }
  for (const a of Object.values(apps)) {
    const d = details.get(a.symbol);
    if (!d) continue;
    if (d.lot > 0) a.lot = d.lot;
    if (d.band && !a.band) a.band = d.band;
    if (a.issuePrice == null && d.band) a.issuePrice = d.band.hi;
    if (d.retailX != null && !a.final) {
      a.retailX = d.retailX;
      a.retailAsOf = d.retailAsOf;
      a.final = today > a.closeDate || (d.retailAsOf || '') >= `${a.closeDate} 17:00`;
    }
  }
  st.openIssues = openMain.sort((a, b) => a.close.localeCompare(b.close)).map((x) => {
    const d = details.get(x.symbol) || {};
    const price = (d.band || x.band)?.hi ?? null;
    return { symbol: x.symbol, name: x.name, open: x.open, close: x.close, band: d.band || x.band, lot: d.lot ?? null, amount: d.lot && price ? d.lot * price : null, retailX: d.retailX ?? null, retailAsOf: d.retailAsOf ?? null };
  });

  // settle at the listing-day open
  for (const a of Object.values(apps)) {
    if (['settled', 'no listing', 'no data'].includes(a.status)) continue;
    if (!a.listingDate) {
      a.expectedListing = tradingDaysBetween(addDays(a.closeDate, 1), addDays(a.closeDate, 20))[R.listingLagSessions - 1] || null;
      if (today > addDays(a.closeDate, 30)) { a.status = 'no listing'; a.note = 'no listing date on NSE 30 days after the close (withdrawn?) — left out of the totals'; }
      continue;
    }
    if (a.listingDate > today) { a.status = 'awaiting listing'; continue; }
    if (a.retailX == null || !(a.lot > 0) || !(a.issuePrice > 0)) {
      a.status = 'waiting for data';
      if (today > addDays(a.listingDate, 7)) { a.status = 'no data'; a.note = 'NSE shows no subscription / lot data for this issue — left out of the totals'; }
      continue;
    }
    const px = storeOpen(a.symbol, a.listingDate) || (await fullFileOpen(a.symbol, a.listingDate, cmFn));
    if (!px) { a.status = 'waiting for price'; continue; }
    Object.assign(a, { status: 'settled', priceSource: px.source, settledOn: today }, settle({ symbol: a.symbol, lot: a.lot, issuePrice: a.issuePrice, retailX: a.retailX, open: px.open, closeDate: a.closeDate, listingDate: a.listingDate, R }));
  }

  // totals (expected value and the one lottery path), tax by financial year of the listing
  const settled = Object.values(apps).filter((a) => a.status === 'settled').sort((x, y) => x.listingDate.localeCompare(y.listingDate));
  const byFy = {};
  for (const a of settled) {
    const f = (byFy[fyOf(a.listingDate)] ||= { fy: `${fyOf(a.listingDate)}–${String(fyOf(a.listingDate) + 1).slice(2)}`, n: 0, expPnl: 0, lotteryPnl: 0, oppCost: 0, allotted: 0 });
    f.n++;
    f.expPnl += a.expPnl;
    f.lotteryPnl += a.lotteryPnl;
    f.oppCost += a.oppCost;
    f.allotted += a.allotted ? 1 : 0;
  }
  for (const f of Object.values(byFy)) {
    f.expTax = Math.max(0, f.expPnl) * R.taxRate;
    f.lotteryTax = Math.max(0, f.lotteryPnl) * R.taxRate;
  }
  const sum = (k) => Object.values(byFy).reduce((s, f) => s + f[k], 0);
  st.byFy = Object.values(byFy).sort((a, b) => a.fy.localeCompare(b.fy));
  st.totals = {
    applications: Object.keys(apps).length,
    settled: settled.length,
    pending: Object.values(apps).filter((a) => !['settled', 'no listing', 'no data'].includes(a.status)).length,
    expected: { pnl: sum('expPnl'), tax: sum('expTax'), afterTax: sum('expPnl') - sum('expTax'), oppCost: sum('oppCost'), net: sum('expPnl') - sum('expTax') - sum('oppCost'), allotments: settled.reduce((s, a) => s + a.p, 0) },
    lottery: { pnl: sum('lotteryPnl'), tax: sum('lotteryTax'), afterTax: sum('lotteryPnl') - sum('lotteryTax'), net: sum('lotteryPnl') - sum('lotteryTax') - sum('oppCost'), allotments: sum('allotted') },
  };
  st.research = RESEARCH;
  st.rules = R;
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return st;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const st = await ipoApplyPaperUpdate();
    const rs = (v) => `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
    const t = st.totals;
    console.log(`IPO apply paper: since ${st.startedAt} · ${t.applications} applications (${t.settled} settled, ${t.pending} pending) · expected ${rs(t.expected.pnl)} before tax, ${rs(t.expected.net)} after tax and opportunity cost · lottery path ${rs(t.lottery.pnl)} (${t.lottery.allotments} allotted)`);
    console.log(`Open mainboard IPOs: ${st.openIssues.map((x) => `${x.symbol} closes ${x.close}${x.lot ? `, lot ${x.lot} ≈ ${rs(x.amount)}` : ''}${x.retailX != null ? `, retail ${x.retailX.toFixed(2)}×` : ''}`).join(' · ') || 'none'} · SME skipped: ${st.smeSkipped}`);
    for (const a of Object.values(st.applications)) console.log(`  ${a.symbol}: closed ${a.closeDate} · ${a.status}${a.listingDate ? ` · lists ${a.listingDate}` : a.expectedListing ? ` · expected listing ≈ ${a.expectedListing}` : ''}${a.retailX != null ? ` · retail ${a.retailX.toFixed(2)}×${a.final ? '' : ' (not final)'}` : ''}${a.lot ? ` · lot ${a.lot} @ ₹${a.issuePrice}` : ''}${a.status === 'settled' ? ` · open ₹${a.open} (${a.priceSource}) · expected ${rs(a.expPnl)} · lottery ${a.allotted ? 'allotted' : 'not allotted'}` : ''}`);
    if (st.fetchError) console.log(`NSE fetch problem: ${st.fetchError}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
