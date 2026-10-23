// Side-by-side comparison of the trading strategies (library): style,
// what the backtest found (after costs), what the paper record shows so far,
// and a plain verdict. Reads the saved results only (no downloads).
// Research / paper only — not investment advice.

import { loadVwapPullback, paperSummary as vwapPaper } from './vwap-pullback.mjs';
import { loadAthSwing, loadAthPaper, loadSurvivorship, summarise as athSum } from './ath-swing.mjs';
import { loadBreakfast, loadBreakfastPaper, summarise as bfSum } from './breakfast.mjs';
import { earlyVerdict } from './weekly.mjs';
import { loadFnoSpreads } from './fno-spreads.mjs';
import { loadFoStrangle, loadFoStranglePaper, summarise as foSum } from './fo-strangle.mjs';
import { loadNiftyDip, loadNiftyDipPaper, summarise as dipSum, ofVersion } from './nifty-dip.mjs';

const pct = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const rs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const R = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(2)} R`);

export function compareStrategies({ vwap = loadVwapPullback(), vp = vwapPaper(), ath = loadAthSwing(), ap = loadAthPaper(), bf = loadBreakfast(), bp = loadBreakfastPaper(), sv = loadSurvivorship(), dip = loadNiftyDip(), dp = loadNiftyDipPaper(), fo = loadFoStrangle(), fp = loadFoStranglePaper(), fs = loadFnoSpreads() } = {}) {
  const rows = [];
  // strong-stock swing
  {
    const pick = ath?.improve?.pick;
    const ver = pick?.adopt ? 'improved' : 'original';
    const paper = (ap?.trades || []).filter((t) => (t.version || 'original') === ver && !t.open);
    const ps = athSum(paper);
    rows.push({
      key: 'ath', name: 'Strong-stock swing', style: 'Swing · days to weeks · delivery',
      test: ath ? `${ath.from?.slice(0, 4)}–${ath.to?.slice(0, 4)}, ${ath.stocks} stocks, ${ath.all.trades} trades` : 'not run',
      backtest: (pick?.adopt ? `${R(pick.test.avgR)} later years · ${R(pick.wideTest.avgR)} unseen stocks (t ${pick.combined.tStat?.toFixed(1)})` : ath ? `${R(ath.all.avgR)} (t ${ath.all.tStat?.toFixed(1)})` : '–')
        + (sv?.results?.[ver] ? ` · without survivorship bias ${R(sv.results[ver].all.avgR)} (t ${sv.results[ver].all.tStat?.toFixed(1)}), ${pct(sv.results[ver].portfolioCagr)}/yr` : '')
        + (sv?.results?.wide && sv.index ? ` · wide-trail paper version ${pct(sv.results.wide.portfolioCagr)}/yr (${pct(sv.results.wide.portfolioCagrAfterTax)} after tax) vs NIFTY ${pct(sv.index.cagr)} (${pct(sv.index.cagrAfterTax)}), not proven` : ''),
      money: ath ? `${pct(pick?.adopt ? pick.portfolioCagr : ath.portfolio.cagr)}/yr vs NIFTY ${pct(ath.portfolio.niftyCagr)} · after tax ${pct((pick?.adopt ? ath.afterTax?.improved : ath.afterTax?.strategy)?.cagrAfter)} vs ${pct(ath.afterTax?.index?.cagrAfter)}` : '–',
      paper: paper.length ? `${paper.length} closed · ${pct(ps.winRate, 0)} won · ${R(ps.avgR)}` : `no closed trades yet (since ${ap?.startedAt || '–'})`,
      paperVerdict: earlyVerdict(paper.length, ps.avgR, ps.tStat, 'R'),
      reliable: !!pick?.adopt && (!sv?.results?.[ver] || (sv.results[ver].all.avgR > 0 && sv.results[ver].all.tStat >= 2)),
      verdict: pick?.adopt
        ? `Best of the four: passed an out-of-sample test${sv?.results?.[ver] ? (sv.results[ver].all.tStat >= 2 && sv.results[ver].all.avgR > 0 ? ' and held up without survivorship bias' : ', but weakened without survivorship bias') : ''}. Still trails a NIFTY fund (more so after tax); best used as a small slice next to an index fund.`
        : 'Slightly positive, not proven.',
    });
  }
  // YouTube VWAP
  {
    const b = vwap?.perTrade;
    const vid = vp?.byVariant?.video;
    rows.push({
      key: 'vwap', name: 'YouTube intraday (VWAP)', style: 'Intraday · 4 stocks · max 2 trades/day',
      test: vwap ? `${vwap.sessions} sessions, ${vwap.stocks?.length || 4} stocks` : 'not run',
      backtest: b ? `${rs(b.avgNetRs)} a trade (t ${b.tStat?.toFixed(1)}); before costs ${rs(vwap.beforeCosts?.avgNetRs)}` : '–',
      money: vwap?.widerList ? `16 other stocks: ${rs(vwap.widerList.avgNetRs)} a trade` : '–',
      paper: vid?.trades ? `${vid.trades} trades · ${pct(vid.winRate, 0)} won · total ${rs(vid.totalNetRs)}` : `no trades yet (since ${vp?.startedAt || '–'})`,
      paperVerdict: vid?.trust?.verdict || '–',
      reliable: false,
      verdict: 'Loses after charges so far; no filter fixed it. Paper only.',
    });
  }
  // Breakfast
  {
    const ps = bfSum(bp?.trades || []);
    rows.push({
      key: 'breakfast', name: 'Breakfast strategy', style: 'Intraday · 9:21–9:45 · sector leaders',
      test: bf ? `${bf.sessions} sessions, ${bf.stocks} stocks, ${bf.both.trades} trades` : 'not run',
      backtest: bf ? `${rs(bf.both.avgNetRs)} a trade (t ${bf.both.tStat?.toFixed(1)}); before costs ${rs(bf.beforeCosts.avgNetRs)}` : '–',
      money: bf ? `stop-out ≈ ${rs(-bf.rules.capital * bf.rules.leverage * bf.rules.stopPct / 100)} on ₹1 lakh at 5×` : '–',
      paper: ps.trades ? `${ps.trades} trades · ${pct(ps.winRate, 0)} won · total ${rs(ps.totalNetRs)}` : `no trades yet (since ${bp?.startedAt || '–'})`,
      paperVerdict: earlyVerdict(ps.trades, ps.avgNetRs, ps.tStat, '₹'),
      reliable: false,
      verdict: 'Breaks even before charges; charges make it lose. Early sample (history grows daily). Paper only.',
    });
  }
  // NIFTY dip-buy
  if (dip || dp) {
    const ps = dipSum(ofVersion(dp?.trades, 'standard'));
    const t = dip?.test;
    const p = dip?.portfolio;
    // deep-dip version (−5% in 10 days): a short mention next to the standard numbers
    const dv = dip?.versions?.deep;
    const dps = dipSum(ofVersion(dp?.trades, 'deep'));
    const deepBt = dv?.test?.trades ? ` · Deep dip (−5% in 10 days): ${pct(dv.test.winRate, 0)} won · ${dv.test.avgRetPct >= 0 ? '+' : ''}${dv.test.avgRetPct.toFixed(2)}% a trade, ~${dv.perYear} a year` : '';
    const deepMoney = dv?.portfolio ? ` · deep dip ${pct(dv.portfolio.cagrAfter)} after tax` : '';
    rows.push({
      key: 'dip', name: 'NIFTY dip-buy', style: 'Index ETF · 3–4 days · ~3 trades a year',
      test: dip ? `${dip.from?.slice(0, 4)}–${dip.to?.slice(0, 4)}, NIFTY, ${dip.all.trades} trades (rules chosen on 2010–2018)` : 'not run',
      backtest: t?.trades ? `2019+: ${pct(t.winRate, 0)} won · ${t.avgRetPct >= 0 ? '+' : ''}${t.avgRetPct.toFixed(2)}% a trade (t ${t.tStat?.toFixed(1)}) · worst ${t.worstPct.toFixed(1)}%${deepBt}` : '–',
      money: p ? `${pct(p.cagr)}/yr vs NIFTY ${pct(p.niftyCagr)} · after tax ${pct(p.cagrAfter)} vs ${pct(p.niftyAfter)}${deepMoney} · in the market ${p.timeInMarketPct.toFixed(0)}% of the time` : '–',
      paper: (ps.trades ? `${ps.trades} closed · ${pct(ps.winRate, 0)} won · total ${rs(ps.totalNetRs)}` : `no closed trades yet (since ${dp?.startedAt || '–'})`) + (dps.trades ? ` · deep dip ${dps.trades} closed, ${pct(dps.winRate, 0)} won, ${rs(dps.totalNetRs)}` : ''),
      paperVerdict: ps.trades ? `${ps.trades} closed: about 3 a year, so a fair verdict needs several years.` : 'No closed trades yet (about 3 a year).',
      reliable: false,
      verdict: 'High win rate (~70–75%) with a small profit per trade, but it sits in cash ~96% of the time, so it trails a NIFTY index fund. Paper only, for learning.',
    });
  }
  // NIFTY weekly short strangle (F&O)
  if (fo || fp) {
    const ps = foSum(fp?.trades || []);
    const w = fo?.worstWeeks?.[0];
    rows.push({
      key: 'fo', name: 'NIFTY short strangle (F&O)', style: 'Weekly options · sell ±2% call + put · held to expiry',
      test: fo ? `${fo.from?.slice(0, 4)}–${fo.to?.slice(0, 4)}, ${fo.all.trades} weeks of real NSE option prices` : 'not run',
      backtest: fo?.all?.trades ? `${pct(fo.all.winRate, 0)} of weeks won · avg ${rs(fo.all.avgRsNowLot)} a lot (t ${fo.all.tStat?.toFixed(1)}; 2019–22 t ${fo.early.tStat?.toFixed(1)}, 2023+ t ${fo.later.tStat?.toFixed(1)})${w ? ` · worst week ${w.retOnMarginPct.toFixed(0)}% of margin (${w.entryDate}, ≈ ${rs(w.rsAtTodaysSize)} a lot at today's size)` : ''}` : '–',
      money: fo?.all?.accountCagr != null ? `${pct(fo.all.accountCagr)}/yr, worst fall ${pct(fo.all.accountMaxDrawdown, 0)} (account = 3× margin) vs NIFTY ${pct(fo.niftyCagr)} · ≈ ₹${Math.round(3 * (fo.marginNow || 0)).toLocaleString('en-IN')} account per lot` : '–',
      paper: ps.trades ? `${ps.trades} weeks · ${pct(ps.winRate, 0)} won · total ${rs(ps.totalRs)}` : `no closed weeks yet (since ${fp?.startedAt || '–'})`,
      paperVerdict: ps.trades ? `${ps.trades} weeks: a fair verdict needs years, and must include a crash.` : 'No closed weeks yet.',
      reliable: false,
      verdict: 'Wins most weeks, then a crash week (March 2020: −77% of margin) wipes out months of gains. Did not beat holding NIFTY overall. ~9 in 10 individual F&O traders lose (SEBI). Paper only.',
    });
  }
  // F&O spreads (specification document)
  if (fs) {
    const md = fs.runs?.spec2y?.results?.['momentum-debit'];
    const ic = fs.runs?.spec2y?.results?.['ivrank-credit'];
    const rc = fs.realCheck?.credit;
    rows.push({
      key: 'fno', name: 'F&O spreads (spec document)', style: 'Stock option spreads · ~10–12 days · defined risk',
      test: `Black-Scholes model, 8 stocks, ${fs.runs?.spec2y?.results?.['momentum-debit']?.from?.slice(0, 4) || '–'}–${fs.to?.slice(0, 4) || '–'}; plus a real NSE price check on NIFTY`,
      backtest: `momentum-debit ${md ? `${md.returnPct.toFixed(1)}%, PF ${md.profitFactor?.toFixed(2)}` : '–'} · ivrank-credit ${ic ? `+${ic.returnPct.toFixed(1)}%, PF ${ic.profitFactor?.toFixed(2)} (model)` : '–'}${rc ? ` · with real prices: PF ${rc.profitFactor?.toFixed(2)}, ${rc.avgR?.toFixed(2)} R a trade` : ''}`,
      money: 'Realistic lots (e.g. RELIANCE 500) need about ₹10 lakh to keep risk at 1% a trade; at that size both lost after charges.',
      paper: 'Not tracked on paper: a model-priced record could only repeat the model.',
      paperVerdict: 'Research result only.',
      reliable: false,
      verdict: 'momentum-debit loses in every check. ivrank-credit looks good only inside the model: real NSE option prices pay less premium when volatility is high, and with real prices it lost. Kept as research only.',
    });
  }
  return {
    rows,
    advice: 'Only the strong-stock swing strategy has passed an honest out-of-sample test, and even it trails a NIFTY index fund after tax. Sensible use: a low-cost index fund as the core, and at most a small slice (e.g. 20%) in the swing strategy once its paper record holds up. Keep both intraday strategies on paper.',
  };
}
