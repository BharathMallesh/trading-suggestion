#!/usr/bin/env node
// Index-fund picker (library + CLI): for the funds that track the same index
// (NIFTY 50, NIFTY Next 50, Sensex), what did investors ACTUALLY get?
//   - NAV history from AMFI via mfapi.in (free, daily). Direct-plan growth
//     options and ETFs only; tax-saver (ELSS, 3-year lock-in), regular / IDCW
//     plans and differently-indexed funds are excluded.
//   - Return over 1 / 3 / 5 years (annualised) and the gap to the best fund on
//     the same index over the same period: funds on one index differ only by
//     costs and tracking quality, so the gap IS what costs + tracking took.
//   - Tracking error (1 year): annualised volatility of the daily NAV return
//     minus the index's daily return (Yahoo; price index — dividend days add
//     tiny noise). Lower = follows the index more faithfully.
//   - Funds whose latest NAV is > 10 days old (merged / closed) are skipped.
// ETF caveat: you buy ETFs at the market price (spread, liquidity), not NAV.
// Expense ratios aren't in this data — check the fund's factsheet.
// Research / education only — not investment advice.
//
//   node paper-bot/index-funds.mjs

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { mapLimit } from '../util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = () => process.env.MF_DIR || join(HERE, 'data', 'mf');
const API = 'https://api.mfapi.in/mf';

export const CATEGORIES = {
  nifty50: { label: 'NIFTY 50', index: '^NSEI', include: /nifty ?50(?! ?(equal|value|alpha|quality|momentum|low|shariah))/i, exclude: /next|200|500|100|bank|midcap|smallcap|equal|value|alpha|quality|momentum|low vol|50:50|arbitrage|25|top 20|smart|shariah/i },
  next50: { label: 'NIFTY Next 50', index: '^NSMIDCP', include: /nifty next ?50/i, exclude: /equal|value|alpha|quality|momentum/i },
  sensex: { label: 'Sensex', index: '^BSESN', include: /sensex/i, exclude: /next|advantage/i },
};
const COMMON_EXCLUDE = /idcw|dividend|regular|payout|bonus|fof|fund of fund|segregated|elss|tax saver/i;

/** Is this scheme a direct-growth index fund or an ETF on the category's index? */
export function matches(name, cat) {
  const c = CATEGORIES[cat];
  if (!c.include.test(name) || c.exclude.test(name) || COMMON_EXCLUDE.test(name)) return false;
  const n = name.toLowerCase();
  const etf = /\betf\b|bees|exchange traded/.test(n);
  return etf || (/direct/.test(n) && /growth/.test(n));
}

async function cachedJson(file, url, maxAgeMs, fetchFn) {
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8'));
      if (Date.now() - c.at < maxAgeMs) return c.data;
    } catch {
      /* refetch */
    }
  }
  const res = await fetchFn(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`mfapi HTTP ${res.status}`);
  const data = await res.json();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ at: Date.now(), data }));
  return data;
}

const toIso = (dmy) => {
  const [d, m, y] = dmy.split('-');
  return `${y}-${m}-${d}`;
};

/**
 * Undo unit splits / consolidations: an index fund can't move −30% / +40% in a
 * day, so such a jump is a change in units, not value. Earlier NAVs are scaled
 * by the jump so returns across it are continuous.
 */
const SPLIT_RATIOS = [1 / 100, 1 / 50, 1 / 25, 1 / 20, 1 / 10, 1 / 5, 1 / 4, 1 / 2, 2, 4, 5, 10, 20, 25, 50, 100];
export function adjustSplits(navs) {
  const out = navs.map((x) => ({ ...x }));
  for (let i = out.length - 1; i > 0; i--) {
    const r = out[i].nav / out[i - 1].nav;
    if (r < 0.7 || r > 1.4) {
      // snap to the nearest standard split ratio so the day's real market move is kept
      const f = SPLIT_RATIOS.reduce((a, b) => (Math.abs(Math.log(r / b)) < Math.abs(Math.log(r / a)) ? b : a));
      for (let j = 0; j < i; j++) out[j].nav *= f;
    }
  }
  return out;
}

/** Annualised return between two NAV points `years` apart (null if history too short). */
function cagr(navs, years) {
  const last = navs[navs.length - 1];
  const target = new Date(Date.parse(last.date) - years * 365.25 * 86400000).toISOString().slice(0, 10);
  // skip a fund's first month: launch-period NAVs (still investing) aren't representative
  const settled = new Date(Date.parse(navs[0].date) + 30 * 86400000).toISOString().slice(0, 10);
  if (settled > target) return null;
  let lo = 0;
  while (lo < navs.length - 1 && navs[lo + 1].date <= target) lo++;
  return (last.nav / navs[lo].nav) ** (1 / years) - 1;
}

/** Annualised tracking error over the last year vs the index (matched dates). */
function trackingError(navs, idx) {
  const map = new Map(idx.map((r) => [r.date, r.close]));
  const start = new Date(Date.parse(navs[navs.length - 1].date) - 365 * 86400000).toISOString().slice(0, 10);
  const pts = navs.filter((x) => x.date >= start && map.has(x.date));
  const d = [];
  for (let i = 1; i < pts.length; i++) d.push(pts[i].nav / pts[i - 1].nav - map.get(pts[i].date) / map.get(pts[i - 1].date));
  if (d.length < 100) return null;
  // trim the 1% most extreme days on each side (dividend ex-dates in the price index)
  const s = [...d].sort((a, b) => a - b);
  const cut = Math.floor(s.length * 0.01);
  const t = s.slice(cut, s.length - cut);
  const m = t.reduce((a, b) => a + b, 0) / t.length;
  return Math.sqrt(t.reduce((a, b) => a + (b - m) ** 2, 0) / t.length) * Math.sqrt(252);
}

export async function indexFunds({ fetchFn = fetch, loadCandles = candles, categories = Object.keys(CATEGORIES) } = {}) {
  const list = await cachedJson(join(DIR(), 'list.json'), API, 7 * 86400000, fetchFn);
  const out = {};
  for (const cat of categories) {
    const c = CATEGORIES[cat];
    const schemes = list.filter((x) => matches(x.schemeName, cat));
    let idx = [];
    try {
      idx = (await loadCandles(c.index, { range: '2y', interval: '1d' })).filter((r) => r.close > 0);
    } catch {
      /* tracking error unavailable */
    }
    const funds = (await mapLimit(schemes, 4, async (s) => {
      try {
        const d = await cachedJson(join(DIR(), `${s.schemeCode}.json`), `${API}/${s.schemeCode}`, 20 * 3600000, fetchFn);
        const navs = adjustSplits((d.data || []).map((x) => ({ date: toIso(x.date), nav: Number(x.nav) })).filter((x) => x.nav > 0).reverse());
        if (navs.length < 200) return null;
        const last = navs[navs.length - 1];
        if ((Date.now() - Date.parse(last.date)) / 86400000 > 10) return null; // stale: merged / closed
        return {
          code: s.schemeCode,
          name: s.schemeName.replace(/\s+/g, ' ').trim(),
          house: d.meta?.fund_house || '',
          type: /\betf\b|bees|exchange traded/i.test(s.schemeName) ? 'ETF' : 'Index fund',
          since: navs[0].date,
          navDate: last.date,
          r1: cagr(navs, 1),
          r3: cagr(navs, 3),
          r5: cagr(navs, 5),
          te: idx.length ? trackingError(navs, idx) : null,
        };
      } catch {
        return null;
      }
    })).filter(Boolean);
    const best = (k) => Math.max(...funds.map((f) => f[k]).filter((v) => v != null));
    const b = { r1: best('r1'), r3: best('r3'), r5: best('r5') };
    for (const f of funds) {
      f.gap1 = f.r1 != null ? f.r1 - b.r1 : null;
      f.gap3 = f.r3 != null ? f.r3 - b.r3 : null;
      f.gap5 = f.r5 != null ? f.r5 - b.r5 : null;
    }
    // rank: 3-year return where available (longer record first), then 1-year
    funds.sort((x, y) => (y.r3 != null) - (x.r3 != null) || (y.r3 ?? -1) - (x.r3 ?? -1) || (y.r1 ?? -1) - (x.r1 ?? -1));
    out[cat] = { label: c.label, index: c.index, funds, best: b };
  }
  return {
    at: new Date().toISOString(),
    categories: out,
    note: 'Funds on the same index differ only by costs and tracking, so the gap to the best fund is what those took (annualised). Tracking error = how far daily NAV moves strayed from the index. ETFs are bought at market price (check liquidity and spread); expense ratios: see each factsheet. Past costs usually persist, but this is not advice.',
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  indexFunds()
    .then((r) => {
      const p = (x) => (x == null ? '   –  ' : `${(x * 100).toFixed(2).padStart(6)}%`);
      for (const c of Object.values(r.categories)) {
        console.log(`\n${c.label} · ${c.funds.length} funds · best 1y ${p(c.best.r1)} · 3y ${p(c.best.r3)} · 5y ${p(c.best.r5)}`);
        console.log('  fund                                                        type        1y      3y      5y   gap 3y  track err');
        for (const f of c.funds.slice(0, 12)) console.log(`  ${f.name.slice(0, 58).padEnd(58)} ${f.type.padEnd(10)} ${p(f.r1)} ${p(f.r3)} ${p(f.r5)} ${p(f.gap3)} ${p(f.te)}`);
        if (c.funds.length > 12) console.log(`  … ${c.funds.length - 12} more; worst 3y gap ${p(Math.min(...c.funds.map((f) => f.gap3).filter((v) => v != null)))}`);
      }
      console.log(`\n${r.note}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
