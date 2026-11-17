#!/usr/bin/env node
// ML stock picks (library + CLI) — PAPER ONLY. From the Nov 2026 walk-forward machine-learning study (loop 7):
// at each month-end, 32 measures for every stock in the NSE top 200 by traded value (returns over 1–12 months,
// residual momentum, volatility, beta, 52-week high/low distance, moving-average gaps, turnover, 42-session delivery
// share…), ranked within the month; three models (ridge regression, gradient-boosted trees, random forest) predict
// next month's return rank and their ranks are averaged ("ENS"). The model for trading year Y is trained on months
// 2009 → October of Y−1 only (the walk-forward schedule). Hold the top 10 in equal parts, keep a holding while it
// stays in the top 40; re-made at the first NSE session after each month-end.
// Research (₹5 lakh, after tax, 2013–26 walk-forward): 17.9%/yr, worst fall 33% vs Momentum 10 19.5% / 39% and
// India mix 15.4% / 26.5% — below the agreed bar; tracked on paper from 17 Nov 2026 as the only fully clean test.
// Needs Python 3 with numpy, pandas and scikit-learn (ML_PYTHON, default /usr/bin/python3). Not advice.
//
//   node --max-old-space-size=12000 paper-bot/ml-picks.mjs --paper

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { loadSeries, pointInTimeUniverse } from './bhav-history.mjs';
import { isEtf, monthEnds } from './momentum.mjs';
import { bufferPick } from './momentum10.mjs';
import { loadDelivery } from './delivery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BHAV = () => process.env.BHAV_EQ_DIR || join(HERE, 'data', 'bhav-eq');
const WORK = () => process.env.ML_WORK_DIR || join(HERE, 'data', 'ml');
const PAPER = () => process.env.ML_PAPER_PATH || join(HERE, 'data', 'ml-picks-paper.json');
const PY = () => process.env.ML_PYTHON || '/usr/bin/python3';
export const ML = { top: 10, keep: 40, capital: 500000, sidePct: 0.175, minDelivDays: 20 };
export const RESEARCH = {
  method: 'walk-forward: retrained every year on earlier years only; 14 test years 2013–2026',
  rows: [
    { label: 'ML picks (top 10, average of 3 models)', all: 0.179, dd: 0.332, recent: 0.159 },
    { label: 'Momentum 10', all: 0.195, dd: 0.39, recent: 0.167 },
    { label: 'India mix', all: 0.154, dd: 0.265, recent: 0.188 },
    { label: 'NIFTY (before tax)', all: 0.122, dd: 0.383, recent: 0.10 },
  ],
  ic: 'out-of-sample rank IC 0.070 (t 3.9) vs Momentum 10 score 0.044; weaker since 2023 (0.049)',
  verdict: 'below the agreed bar (behind Momentum 10, deeper falls than India mix) — paper only',
};
export const loadMlPaper = () => {
  try {
    return JSON.parse(readFileSync(PAPER(), 'utf8'));
  } catch {
    return null;
  }
};
const bhavMonths = (to) => readdirSync(BHAV()).filter((f) => /^\d{4}-\d\d\.json\.gz$/.test(f)).map((f) => f.slice(0, 7)).filter((m) => m <= to.slice(0, 7)).sort();

/** Write the inputs the Python step reads, using only data dated ≤ signal. */
export async function exportData(signal, { loadCandles = candles } = {}) {
  const D = join(WORK(), signal);
  if (existsSync(join(D, 'done'))) return D;
  mkdirSync(D, { recursive: true });
  const raw = loadSeries({ months: bhavMonths(signal) });
  const series = new Map();
  for (const [s, rows] of raw) {
    const r = rows.filter((x) => x.date <= signal && x.close > 0);
    if (r.length) series.set(s, r);
  }
  const universe = pointInTimeUniverse(series);
  const nifty = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2007-01-01') / 1000), period2: Math.floor(Date.parse(`${signal}T00:00:00Z`) / 1000) + 86400, interval: '1d' }))
    .filter((r) => r.date <= signal && r.close > 0);
  const lastBhav = [...series.values()].reduce((a, r) => (r.at(-1).date > a ? r.at(-1).date : a), '');
  const ends = monthEnds(nifty.map((x) => x.date).filter((d) => d <= lastBhav));
  const nextM = (ym) => { const [a, b] = ym.split('-').map(Number); return b === 12 ? `${a + 1}-01` : `${a}-${String(b + 1).padStart(2, '0')}`; };
  const U = ['signal,sym'];
  const need = new Set();
  for (const e of ends) {
    const u = universe.get(nextM(e.slice(0, 7)));
    if (!u) continue;
    for (const s of u) if (!isEtf(s)) { U.push(`${e},${s}`); need.add(s); }
  }
  writeFileSync(join(D, 'univ.csv'), U.join('\n'));
  writeFileSync(join(D, 'monthends.csv'), `date\n${ends.join('\n')}`);
  writeFileSync(join(D, 'nifty.csv'), `date,close\n${nifty.map((r) => `${r.date},${r.close}`).join('\n')}`);
  const P = ['sym,date,open,high,low,close,val'];
  for (const s of need) for (const r of series.get(s) || []) P.push(`${s},${r.date},${r.open},${r.high},${r.low},${r.close},${r.val}`);
  writeFileSync(join(D, 'px.csv.gz'), gzipSync(P.join('\n')));
  const L = ['sym,date,qty,deliv'];
  const deliv = loadDelivery(signal);
  for (const [d, rows] of deliv) for (const [s, v] of Object.entries(rows)) if (need.has(s)) L.push(`${s},${d},${v[0]},${v[1]}`);
  writeFileSync(join(D, 'deliv.csv.gz'), gzipSync(L.join('\n')));
  writeFileSync(join(D, 'meta.json'), JSON.stringify({ TO: signal, lastBhav, syms: need.size, delivDays: deliv.size, lastDeliv: [...deliv.keys()].sort().at(-1) || null }));
  writeFileSync(join(D, 'done'), '1');
  return D;
}

/** Run the frozen Python model for `signal` → ranked [{symbol, ens, ridge, hgb, rf}] (best first). */
export function rankSignal(D, signal) {
  const py = (...a) => execFileSync(PY(), ['-I', join(HERE, 'ml', 'mlcore.py'), ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26, timeout: 3_600_000 }).toString();
  if (!existsSync(join(D, 'features.pkl'))) py('features', D);
  const info = JSON.parse(py('live', D, signal).trim().split('\n').at(-1));
  const lines = readFileSync(join(D, `live-${signal}.csv`), 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const col = (n) => head.indexOf(n);
  const ranked = lines.slice(1).map((l) => l.split(',')).map((c) => ({ symbol: c[col('sym')], ens: +c[col('ens')], ridge: +c[col('ridge')], hgb: +c[col('hgb')], rf: +c[col('rf')] }));
  ranked.sort((a, b) => b.ens - a.ens);
  return { ranked, info };
}

/** Re-make the paper book at the trade session: value the holdings, equal parts of the new list, charges on what changed. */
export function rebalanceBook(book, list, px, date, R = ML) {
  const value = book.cash + book.holdings.reduce((a, h) => a + h.amount * (px(h.symbol, date, 'mid') / h.entry), 0);
  const want = new Map(list.map((s) => [s, value / list.length]));
  let traded = 0;
  for (const h of book.holdings) traded += Math.abs((want.get(h.symbol) || 0) - h.amount * (px(h.symbol, date, 'mid') / h.entry));
  for (const s of list) if (!book.holdings.some((h) => h.symbol === s)) traded += want.get(s);
  const cost = (traded * R.sidePct) / 100;
  const per = (value - cost) / list.length;
  const missing = list.filter((s) => !px(s, date, 'mid'));
  const holdings = list.filter((s) => !missing.includes(s)).map((s) => ({ symbol: s, entryDate: date, entry: px(s, date, 'mid'), amount: per }));
  return { holdings, cash: per * missing.length, value: value - cost, cost, missing };
}

export async function mlPaperUpdate({ now = new Date(), loadCandles = candles, ranker = rankSignal, log = () => {} } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const st = loadMlPaper() || { startedAt: today, capital: ML.capital, cash: ML.capital, holdings: [], rebalances: [], curve: [], held: [] };
  const months = readdirSync(BHAV()).filter((f) => /^\d{4}-\d\d\.json\.gz$/.test(f)).map((f) => f.slice(0, 7)).sort();
  const recent = months.slice(-3);
  const series = loadSeries({ months: recent });
  const byDate = new Map();
  for (const [s, rows] of series) for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    byDate.get(r.date).set(s, r);
  }
  const days = [...byDate.keys()].sort();
  const lastDate = days.at(-1);
  const px = (s, d, kind = 'close') => {
    const r = byDate.get(d)?.get(s);
    if (r) return kind === 'mid' ? (r.open + r.close) / 2 : r.close;
    if (kind === 'mid') return null;
    const rows = series.get(s);
    const prev = rows?.filter((x) => x.date <= d).at(-1);
    return prev ? prev.close : null;
  };
  // the latest month-end whose next session exists = the signal to act on
  const ends = monthEnds(days);
  const signal = ends.filter((e) => days.some((d) => d > e)).at(-1);
  if (signal && signal !== st.lastSignal) {
    const deliv = loadDelivery(signal, `${signal.slice(0, 7)}-01`);
    if (deliv.size < 5) throw new Error(`delivery data for ${signal.slice(0, 7)} is missing — run paper-bot/delivery.mjs first`);
    log(`ML picks: building the ranking for the ${signal} month-end…`);
    const D = await exportData(signal, { loadCandles });
    const { ranked, info } = ranker(D, signal);
    const list = bufferPick(ranked, new Set(st.held), ML.top, ML.keep).map((x) => x.symbol);
    const rankOf = new Map(ranked.map((x, i) => [x.symbol, i + 1]));
    st.pending = { signal, list, ranks: list.map((s) => rankOf.get(s)), top40: ranked.slice(0, 40).map((x) => ({ symbol: x.symbol, ens: +x.ens.toFixed(4) })), model: info,
      buy: list.filter((s) => !st.held.includes(s)), sell: st.held.filter((s) => !list.includes(s)) };
    st.lastSignal = signal;
    st.held = list;
  }
  // act on a pending list at the first session after its month-end that is on/after the paper start
  if (st.pending) {
    const tradeDay = days.find((d) => d > st.pending.signal && d >= st.startedAt);
    if (tradeDay) {
      const r = rebalanceBook({ cash: st.cash, holdings: st.holdings }, st.pending.list, px, tradeDay);
      st.rebalances.push({ signal: st.pending.signal, date: tradeDay, list: st.pending.list, ranks: st.pending.ranks, buy: st.pending.buy, sell: st.pending.sell, value: Math.round(r.value), cost: Math.round(r.cost), missing: r.missing });
      st.holdings = r.holdings;
      st.cash = r.cash;
      st.top40 = st.pending.top40;
      st.model = st.pending.model;
      delete st.pending;
    }
  }
  const marks = st.holdings.map((h) => {
    const last = px(h.symbol, lastDate) ?? h.entry;
    return { ...h, last, value: h.amount * (last / h.entry), retPct: (last / h.entry - 1) * 100 };
  });
  const value = st.cash + marks.reduce((a, m) => a + m.value, 0);
  if (lastDate && lastDate >= st.startedAt) st.curve = [...st.curve.filter((c) => c.date !== lastDate), { date: lastDate, value: Math.round(value) }];
  let peak = st.capital;
  let maxDD = 0;
  for (const c of st.curve) { peak = Math.max(peak, c.value); maxDD = Math.max(maxDD, 1 - c.value / peak); }
  Object.assign(st, { lastDate, value: Math.round(value), maxDD, marks, research: RESEARCH, rules: ML, updatedAt: now.toISOString() });
  writeJsonAtomic(PAPER(), st);
  return st;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const st = await mlPaperUpdate({ log: (m) => console.log(m) });
    const rs = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
    const p = st.pending;
    console.log(`ML picks paper since ${st.startedAt} (NSE data to ${st.lastDate}): value ${rs(st.value)} · holding ${st.holdings.map((h) => h.symbol).join(', ') || 'nothing yet'}${p ? ` · buy at the next session (${p.signal} list): ${p.list.join(', ')}` : ''}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
