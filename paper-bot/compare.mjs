// Side-by-side comparison of the trading strategies (library): style,
// what the backtest found (after costs), what the paper record shows so far,
// and a plain verdict. Reads the saved results only (no downloads).
// Research / paper only — not investment advice.

import { loadVwapPullback, paperSummary as vwapPaper } from './vwap-pullback.mjs';
import { loadAthSwing, loadAthPaper, loadSurvivorship, summarise as athSum } from './ath-swing.mjs';
import { loadBreakfast, loadBreakfastPaper, summarise as bfSum } from './breakfast.mjs';
import { earlyVerdict } from './weekly.mjs';
import { loadFnoSpreads } from './fno-spreads.mjs';
import { loadRsiSwing, loadRsiSwingPaper, summarise as rsiSum } from './rsi-swing.mjs';
import { loadFoStrangle, loadFoStranglePaper, summarise as foSum } from './fo-strangle.mjs';
import { loadNiftyDip, loadNiftyDipPaper, summarise as dipSum, ofVersion } from './nifty-dip.mjs';
import { loadIntraday5y } from './intraday-5y.mjs';
import { loadOneFifteen, paperSummary as oneFifteenPaper } from './one-fifteen.mjs';
import { loadMatrixCalendar } from './matrix-calendar.mjs';
import { loadImbalanceSwing, loadImbalancePaper } from './imbalance-swing.mjs';
import { loadE2Paper } from './e2-swing.mjs';
import { loadLbbPaper } from './lbb-swing.mjs';
import { loadBonusRunupPaper } from './bonus-runup.mjs';
import { loadIpoApplyPaper } from './ipo-apply.mjs';

const pct = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const rs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const R = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(2)} R`);
const safe = (f) => {
  try {
    return f();
  } catch {
    return null;
  }
};
/** "3,384 trades 2020-01-01 → 2026-11-23: −₹193 a trade (t −9.5), total −₹6,53,145" from an intraday-5y block. */
const fiveYear = (x) => (x?.all?.trades ? `${x.all.trades.toLocaleString('en-IN')} trades ${x.from} → ${x.to}: ${rs(x.all.avg)} a trade (t ${x.all.tStat?.toFixed(1)}), total ${rs(x.all.total)}${x.beforeCosts?.trades ? `; before costs ${rs(x.beforeCosts.avg)} a trade` : ''}` : null);

// Every Trading strategies sub-tab has a row (round 79, S-B4); the intraday rows use the 5-year intraday run.
export function compareStrategies({ vwap = loadVwapPullback(), vp = vwapPaper(), ath = loadAthSwing(), ap = loadAthPaper(), bf = loadBreakfast(), bp = loadBreakfastPaper(), sv = loadSurvivorship(), dip = loadNiftyDip(), dp = loadNiftyDipPaper(), fo = loadFoStrangle(), fp = loadFoStranglePaper(), fs = loadFnoSpreads(), rsiTest = loadRsiSwing(), rsiPaper = loadRsiSwingPaper(), i5 = loadIntraday5y(), r115 = loadOneFifteen(), r115p = safe(oneFifteenPaper), mc = loadMatrixCalendar(), imb = loadImbalanceSwing(), imbP = loadImbalancePaper(), e2 = loadE2Paper(), lbb = loadLbbPaper(), bsr = loadBonusRunupPaper(), ipo = loadIpoApplyPaper() } = {}) {
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
        ? `Passed an out-of-sample test${sv?.results?.[ver] ? (sv.results[ver].all.tStat >= 2 && sv.results[ver].all.avgR > 0 ? ' and held up without survivorship bias' : ', but weakened without survivorship bias') : ''}. Still trails a NIFTY fund (more so after tax); best used as a small slice next to an index fund.`
        : 'Slightly positive, not proven.',
    });
  }
  // YouTube VWAP
  {
    const b = vwap?.perTrade;
    const vid = vp?.byVariant?.video;
    rows.push({
      key: 'vwap', name: 'YouTube intraday (VWAP)', style: 'Intraday · 4 stocks · max 2 trades/day',
      test: i5?.vwap?.video?.all?.trades ? `Groww 5-minute bars ${i5.vwap.video.from?.slice(0, 4)}–${i5.vwap.video.to?.slice(0, 4)}, ${i5.vwap.video.stocks} stocks (video rules)` : vwap ? `${vwap.sessions} sessions, ${vwap.stocks?.length || 4} stocks` : 'not run',
      backtest: fiveYear(i5?.vwap?.video) ? `${fiveYear(i5.vwap.video)}${i5.vwap.improved?.all?.trades ? ` · improved version ${rs(i5.vwap.improved.all.avg)} a trade (t ${i5.vwap.improved.all.tStat?.toFixed(1)})` : ''}` : b ? `${rs(b.avgNetRs)} a trade (t ${b.tStat?.toFixed(1)}); before costs ${rs(vwap.beforeCosts?.avgNetRs)}` : '–',
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
      test: i5?.breakfast?.all?.trades ? `Groww 5-minute bars ${i5.breakfast.from?.slice(0, 4)}–${i5.breakfast.to?.slice(0, 4)}, ${i5.breakfast.stocks} stocks` : bf ? `${bf.sessions} sessions, ${bf.stocks} stocks, ${bf.both.trades} trades` : 'not run',
      backtest: fiveYear(i5?.breakfast) || (bf ? `${rs(bf.both.avgNetRs)} a trade (t ${bf.both.tStat?.toFixed(1)}); before costs ${rs(bf.beforeCosts.avgNetRs)}` : '–'),
      money: bf ? `stop-out ≈ ${rs(-bf.rules.capital * bf.rules.leverage * bf.rules.stopPct / 100)} on ₹1 lakh at 5×` : '–',
      paper: ps.trades ? `${ps.trades} trades · ${pct(ps.winRate, 0)} won · total ${rs(ps.totalNetRs)}` : `no trades yet (since ${bp?.startedAt || '–'})`,
      paperVerdict: earlyVerdict(ps.trades, ps.avgNetRs, ps.tStat, '₹'),
      reliable: false,
      verdict: i5?.breakfast?.all?.trades ? 'Lost after charges over five years of 5-minute bars, in both 2020–22 and 2023 →. Paper only.' : 'Breaks even before charges; charges make it lose. Early sample (history grows daily). Paper only.',
    });
  }
  // 1:15 PM reversal (YouTube), stock versions at the 3% threshold
  if (r115 || r115p?.startedAt) {
    const v = r115?.results?.['V|3|reversal']?.account?.all;
    const sv2 = r115?.results?.['S|3|reversal']?.account?.all;
    const pv = r115p?.byVersion || {};
    const paperBits = ['V', 'S', 'I'].filter((k) => pv[k]?.trades).map((k) => `${k} ${pv[k].trades} · ${rs(pv[k].totalNetRs ?? pv[k].net)}`);
    rows.push({
      key: 'r115', name: '1:15 PM reversal', style: 'Intraday · after a ≥ 3% move by 1:15 PM · max 2 trades/day',
      test: r115 ? `${r115.from?.slice(0, 4)}–${r115.to?.slice(0, 4)}, ${r115.stocks} stocks (Groww 5-minute bars)` : 'not run',
      backtest: v?.trades ? `video version ${v.trades.toLocaleString('en-IN')} trades, ${R(v.avgRNet)} a trade, total ${rs(v.totalNetRs)}${sv2?.trades ? ` · same-day version ${R(sv2.avgRNet)}, total ${rs(sv2.totalNetRs)}` : ''}` : '–',
      money: '₹1,000 risk a trade',
      paper: paperBits.length ? paperBits.join(' · ') : `no trades yet (since ${r115p?.startedAt || '–'})`,
      paperVerdict: 'Too early to judge.',
      reliable: false,
      verdict: r115?.verdict ? 'Does not work after costs (failed its pre-registered test). Paper only.' : 'Not tested yet.',
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
  // RSI swing (oversold bounce, Rathod interview)
  if (rsiTest?.results) {
    const c = rsiTest.results[`long-${rsiTest.chosen}`];
    const ps = rsiSum(rsiPaper?.trades || []);
    rows.push({
      key: 'rsi', name: 'RSI swing (oversold bounce)', style: 'Daily + hourly RSI, hourly candle entry · 2–6 days · delivery',
      test: `${rsiTest.from?.slice(0, 7)} → ${rsiTest.to?.slice(0, 7)}, ${rsiTest.stocks} stocks, ${c.all.trades} trades`,
      backtest: `${c.all.avgRetPct >= 0 ? '+' : ''}${c.all.avgRetPct.toFixed(2)}% a trade after charges (t ${c.all.tStat?.toFixed(1)}); second year ${c.second.avgRetPct >= 0 ? '+' : ''}${c.second.avgRetPct.toFixed(2)}% (t ${c.second.tStat?.toFixed(1)})`,
      money: c.portfolio?.cagr != null ? `₹1 lakh at 1% risk: ${pct(c.portfolio.cagr)} a year` : '–',
      paper: ps.trades ? `${ps.trades} closed · ${pct(ps.winRate, 0)} won · ${ps.avgRetPct.toFixed(2)}% a trade` : `no closed trades yet (since ${rsiPaper?.startedAt || '–'})`,
      paperVerdict: earlyVerdict(ps.trades, ps.avgRetPct, ps.tStat, '%'),
      reliable: !!rsiTest.passed,
      verdict: rsiTest.passed ? 'Passed its test.' : 'Lost after charges on the second year; about break-even before charges. Paper only.',
    });
  }
  // Matrix calendar (NIFTY options)
  if (mc?.all?.matrix) {
    const m = mc.all.matrix;
    rows.push({
      key: 'mc', name: 'Matrix calendar', style: 'NIFTY weekly / monthly options · held a week',
      test: `${mc.from?.slice(0, 4)}–${mc.to?.slice(0, 4)}, ${m.n} weeks of real NSE option prices`,
      backtest: `${pct(m.win, 0)} of weeks won · ${rs(m.avg)} a set (t ${m.t?.toFixed(1)}), total ${rs(m.total)}${mc.all.condor ? ` · condor comparison ${rs(mc.all.condor.avg)} a set (t ${mc.all.condor.t?.toFixed(1)})` : ''}`,
      money: m.maxDrawdown ? `worst fall ${rs(-m.maxDrawdown)}` : '–',
      paper: 'Research result only (no paper record).',
      paperVerdict: 'Research result only.',
      reliable: !!mc.passed,
      verdict: mc.passed ? 'Passed its test.' : 'Lost after charges. Research only.',
    });
  }
  // Imbalance swing
  if (imb?.all || imbP) {
    const a = imb?.all;
    const ps = imbP?.summary;
    rows.push({
      key: 'imb', name: 'Imbalance swing', style: 'Swing · weeks · delivery',
      test: imb ? `${imb.from?.slice(0, 4)}–${imb.to?.slice(0, 4)}, ${a?.trades} trades` : 'not run',
      backtest: a?.trades ? `${pct(a.winRate, 0)} won · ${R(a.avgR)} a trade (t ${a.tStat?.toFixed(1)}) · median ${R(a.medianR)}` : '–',
      money: '–',
      paper: (imbP?.trades || []).length ? `${imbP.trades.filter((t) => !t.open).length} closed · ${(imbP.trades || []).filter((t) => t.open).length} open${ps?.avgR != null ? ` · ${R(ps.avgR)} a trade` : ''}` : `no trades yet (since ${imbP?.startedAt || '–'})`,
      paperVerdict: 'Too early to judge.',
      reliable: !!imb?.passed,
      verdict: imb?.passed ? 'Passed its test; paper record running.' : 'Slightly positive per trade but driven by a few big winners; not proven. Paper only.',
    });
  }
  // Momentum breakout (E2), Leader box breakout: frozen rules with dev / val / test periods
  const swingRow = (key, name, style, st, perTrade) => {
    const t = st?.research?.test;
    const sm = st?.summary;
    rows.push({
      key, name, style,
      test: st?.research ? ['dev', 'val', 'test'].map((k) => st.research[k]?.period).filter(Boolean).join(' / ') : 'not run',
      backtest: t ? `unseen ${t.period}: ${t.trades} trades, ${perTrade(t)} (t ${t.t}), ${pct(t.afterTaxPerYear)}/yr after tax, worst fall ${pct(t.maxDD, 0)}` : '–',
      money: st?.value ? `paper account ${rs(st.value - (st.rules?.capital || 0))} on ${rs(st.rules?.capital || 0).replace('+', '')}` : '–',
      paper: sm ? `${sm.closed} closed · ${sm.open} open${sm.avgR != null ? ` · ${R(sm.avgR)} a trade` : ''}` : `no trades yet (since ${st?.startedAt || '–'})`,
      paperVerdict: 'Too early to judge.',
      reliable: false,
      verdict: 'Failed its unseen test period (no reliable per-trade edge). Paper only.',
    });
  };
  if (e2) swingRow('e2', 'Momentum breakout', 'Swing · momentum stocks · pivot breakout · weeks', e2, (t) => R(t.avgR));
  if (lbb) swingRow('lbb', 'Leader box breakout', 'Swing · market leaders · box breakout · weeks', lbb, (t) => `${t.perTradePct >= 0 ? '+' : ''}${t.perTradePct}% a trade`);
  // Bonus / split run-up
  if (bsr) {
    const last = bsr.research?.rows?.at(-1);
    const sm = bsr.summary;
    rows.push({
      key: 'bsr', name: 'Bonus/split run-up', style: 'Event swing · buy before the record date · days to weeks',
      test: (bsr.research?.rows || []).map((r) => r.period).join(' / ') || 'not run',
      backtest: last ? `${last.period}: ${last.trades} trades, +${last.excessPct}% a trade vs NIFTY (t ${last.t}), account ${pct(last.account)}/yr` : '–',
      money: last?.note || '–',
      paper: sm ? `${sm.closed} closed · ${sm.open} open · ${pct(sm.avgRetPct / 100)} a trade` : `no trades yet (since ${bsr.startedAt || '–'})`,
      paperVerdict: 'Too early to judge.',
      reliable: false,
      verdict: 'A real per-trade edge in all three periods, but the account trailed India mix in 2025–26. Paper.',
    });
  }
  // IPO apply
  if (ipo) {
    const rr = ipo.research;
    const t = ipo.totals;
    rows.push({
      key: 'ipo', name: 'IPO apply', style: 'Minimum lot in every mainboard IPO · sell at the listing open',
      test: (rr?.rows || []).map((r) => r.period).join(' / ') || 'not run',
      backtest: rr?.rows?.length ? `${rr.rows.at(-1).period}: about ${rs(rr.rows.at(-1).perYear)} a year (t ${rr.t}); without the 10 best IPOs ${rs(rr.exBest10)} a year` : '–',
      money: rr?.appsPerYear ? `a fixed amount per PAN (one minimum lot each time), about ${rr.appsPerYear} applications a year` : '–',
      paper: t ? `${t.applications} applied · ${t.settled} settled · ${t.pending} pending` : `no applications yet (since ${ipo.startedAt || '–'})`,
      paperVerdict: 'Too early to judge.',
      reliable: false,
      verdict: 'A small add-on (a fixed few thousand rupees a year, uneven), not a portfolio. Paper.',
    });
  }
  return {
    rows,
    // counts come from the rows; the advice matches the Research summary (Home)
    advice: `${rows.length} trading strategies side by side. None beats the tested monthly mix: India mix (Investing → India mix) is the best tested rule, with a low-cost index fund as the simple alternative. Here, IPO apply is a small add-on and the bonus/split run-up has a real per-trade edge (both paper); the strong-stock swing passed an out-of-sample test but trails a NIFTY index fund after tax. The intraday and F&O strategies lost after charges — keep them on paper.`,
  };
}
