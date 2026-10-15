// 05-strategies.js — Strategy comparison, Breakfast strategy, strong-stock swing, phone access.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// --- Strategy comparison ---
lazy('Strategy comparison', async () => {
  try {
    const d = await api('/api/strategies/compare');
    const head = ['', ...d.rows.map((r) => `<b>${esc(r.name)}</b>${r.reliable ? ' <span style="color:var(--up);font-size:11px">passed test</span>' : ''}`)];
    const line = (label, f) => `<tr><td style="text-align:left;color:var(--muted)">${label}</td>${d.rows.map((r) => `<td style="text-align:left">${f(r)}</td>`).join('')}</tr>`;
    $('cmpOut').innerHTML = `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr>${head.map((h) => `<th style="text-align:left">${h}</th>`).join('')}</tr></thead><tbody>
      ${line('Style', (r) => esc(r.style))}
      ${line('Tested on', (r) => esc(r.test))}
      ${line('Backtest (after costs)', (r) => esc(r.backtest))}
      ${line('In money', (r) => esc(r.money))}
      ${line('Paper record', (r) => esc(r.paper))}
      ${line('Paper verdict', (r) => `<span class="note">${esc(r.paperVerdict)}</span>`)}
      ${line('Verdict', (r) => `<b style="color:${r.reliable ? 'var(--up)' : 'var(--ink)'}">${esc(r.verdict)}</b>`)}
    </tbody></table></div>
    <div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px">${esc(d.advice)}</div>
    <div class="note">R = result in multiples of the amount risked per trade. Research only, not investment advice.</div>`;
  } catch (e) {
    $('cmpOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});

// --- Breakfast strategy ---
function bfRender(d) {
  const b = d.backtest;
  const rs = (v) => (v == null ? '–' : (v < 0 ? '−₹' : '₹') + Math.abs(Math.round(v)).toLocaleString('en-IN'));
  const pc = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
  let html = '';
  if (b) {
    const row = (n, x) => !x?.trades ? '' : `<tr><td style="text-align:left">${esc(n)}</td><td>${x.trades}</td><td>${pc(x.winRate)}</td><td>${rs(x.avgGrossRs)}</td><td>${rs(x.avgChargesRs)}</td><td style="color:${x.avgNetRs >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${rs(x.avgNetRs)}</b></td><td style="color:${x.totalNetRs >= 0 ? 'var(--up)' : 'var(--down)'}">${rs(x.totalNetRs)}</td><td>${x.exits.target}/${x.exits.stop}/${x.exits['9:45']}</td><td>${x.tStat?.toFixed(1) ?? '–'}</td></tr>`;
    html += `<div style="font-size:14px"><b>Backtest: ${b.stocks} stocks, ${b.sessions} sessions (${esc(b.from)} → ${esc(b.to)})</b> · ₹1 lakh at 5× = ₹5 lakh per trade</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Version</th><th>Trades</th><th>Won</th><th>Avg before costs</th><th>Avg charges</th><th>Avg after costs</th><th>Total</th><th>Target / stop / 9:45</th><th>t</th></tr></thead><tbody>
        ${row('Long only (strongest sector)', b.longOnly)}${row('Short only (weakest sector)', b.shortOnly)}${row('Both', b.both)}${row(`…before ${b.splitDate}`, b.halves.first)}${row(`…from ${b.splitDate}`, b.halves.second)}</tbody></table></div>
      <div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px"><b>Verdict:</b> before charges it ${Math.abs(b.beforeCosts.avgNetRs) < 150 ? 'about broke even' : b.beforeCosts.avgNetRs > 0 ? 'made money' : 'lost money'} (${rs(b.beforeCosts.avgNetRs)} a trade); intraday charges of about ${rs(b.both.avgChargesRs)} a trade ${b.both.avgNetRs < 0 ? 'turn it into a loss' : 'leave it ahead'} (${rs(b.both.avgNetRs)}). With 5× leverage a stop-out costs about ${rs(-b.rules.capital * b.rules.leverage * b.rules.stopPct / 100)} on ₹1 lakh. Only ${b.sessions} sessions so far: the history grows every day, so this is an early read.</div>
      <details><summary style="cursor:pointer;font-size:13px">Recent sessions</summary><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Date</th><th>NIFTY 9:15–9:20</th><th>Strongest sector</th><th>Long pick</th><th>Result</th><th>Weakest sector</th><th>Short pick</th><th>Result</th></tr></thead><tbody>${b.recent.map((x) =>
        `<tr><td style="text-align:left">${esc(x.date)}</td><td>${x.niftyMovePct != null ? (x.niftyMovePct >= 0 ? '+' : '') + x.niftyMovePct.toFixed(2) + '%' : '–'}</td><td>${esc(x.topSector || '–')}</td><td>${x.long ? esc(x.long.symbol.replace('.NS', '')) : '–'}</td><td style="color:${(x.long?.net ?? 0) >= 0 ? 'var(--up)' : 'var(--down)'}">${x.long ? `${esc(x.long.reason)} ${rs(x.long.net)}` : '–'}</td><td>${esc(x.bottomSector || '–')}</td><td>${x.short ? esc(x.short.symbol.replace('.NS', '')) : '–'}</td><td style="color:${(x.short?.net ?? 0) >= 0 ? 'var(--up)' : 'var(--down)'}">${x.short ? `${esc(x.short.reason)} ${rs(x.short.net)}` : '–'}</td></tr>`).join('')}</tbody></table></div></details>
      <div class="note">${esc(b.note)}</div>`;
  } else html += '<div class="note">Backtest not run yet.</div>';
  const p = d.paper;
  if (p) html += `<div style="font-size:14px;margin-top:8px"><b>Paper record</b> since ${esc(p.startedAt)}: ${p.summary.trades ? `${p.summary.trades} trades · won ${pc(p.summary.winRate)} · total ${rs(p.summary.totalNetRs)}` : 'no trades yet (recorded after each close)'}</div>`;
  $('bfOut').innerHTML = html;
}
lazy('Breakfast strategy', async () => {
  try { bfRender(await api('/api/breakfast')); } catch (e) { $('bfOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
$('bfRunBtn').addEventListener('click', async () => {
  $('bfOut').innerHTML = '<div class="note">Re-running on all saved 5-minute history…</div>';
  try {
    const r = await api('/api/breakfast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    bfRender({ ...(await api('/api/breakfast')), backtest: r.backtest });
  } catch (e) { $('bfOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
$('bfTodayBtn').addEventListener('click', async () => {
  $('bfTodayBtn').disabled = true;
  $('bfToday').innerHTML = '<div class="note">Reading the first five minutes for 200 stocks (10–20 seconds)…</div>';
  try {
    const d = await api('/api/breakfast/today');
    const sg = (x) => (x == null ? '–' : (x >= 0 ? '+' : '') + x.toFixed(2) + '%');
    const rs = (v) => (v == null ? '–' : (v < 0 ? '−₹' : '+₹') + Math.abs(Math.round(v)).toLocaleString('en-IN'));
    const pick = (p, side) => {
      if (!p) return `<div class="note">No ${side === 'long' ? 'long' : 'short'} today: ${side === 'long' ? 'no sector was up, or its leaders were up 5%+' : 'no sector was down, or its laggards were down 5%+'}. Skipping is part of the strategy.</div>`;
      const t = p.trade;
      return `<div style="padding:8px 10px;border:1px solid ${side === 'long' ? 'var(--up)' : 'var(--down)'};border-radius:10px;font-size:13px">
        <b style="color:${side === 'long' ? 'var(--up)' : 'var(--down)'}">${side === 'long' ? 'Long' : 'Short'}: ${esc(p.symbol.replace('.NS', ''))}</b> (${esc(p.sector)} ${sg(p.sectorAvg)}; stock ${sg(p.move)} in the first 5 min)
        ${t ? `<br>Entry ₹${t.entry.toFixed(2)} at ~9:21 · stop ₹${t.stop.toFixed(2)} · target ₹${t.target.toFixed(2)} (${t.targetPct}%${t.targetPct < 1 ? ', NIFTY against' : ''}) · <b>${t.open ? 'open' : esc(t.reason)}</b> ${rs(t.net)} after charges on ₹5 lakh` : '<br>Waiting for the 9:20 candle.'}</div>`;
    };
    $('bfToday').innerHTML = `<div style="font-size:14px"><b>${d.live ? 'Live' : 'Latest session'} · ${esc(d.date)}</b> · NIFTY first 5 min ${sg(d.niftyMovePct)}</div>
      ${d.ready ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-top:8px">${pick(d.long, 'long')}${pick(d.short, 'short')}</div>` : ''}
      <div style="font-size:13px;margin-top:10px"><b>Sector heat map, 9:15–9:20</b></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">${d.sectors.map((x) => {
        const a = Math.min(1, Math.abs(x.avg) / 1.5);
        return `<div title="${esc(x.name)}: ${x.count} stocks · leader ${esc((x.leader || '').replace('.NS', ''))} · laggard ${esc((x.laggard || '').replace('.NS', ''))}" style="padding:6px 8px;border-radius:8px;font-size:12px;border:1px solid var(--line);background:${x.avg >= 0 ? `rgba(22,163,74,${0.08 + a * 0.35})` : `rgba(220,38,38,${0.08 + a * 0.35})`}"><b>${esc(x.name)}</b> ${sg(x.avg)}</div>`;
      }).join('')}</div>
      ${d.alternatives?.long?.length ? `<div class="note">Other long candidates (top sectors): ${d.alternatives.long.map((x) => `${esc(x.sector)} → ${esc((x.stock || '–').replace('.NS', ''))}`).join(' · ')}</div>` : ''}
      ${d.alternatives?.short?.length ? `<div class="note">Other short candidates (weakest sectors): ${d.alternatives.short.map((x) => `${esc(x.sector)} → ${esc((x.stock || '–').replace('.NS', ''))}`).join(' · ')}</div>` : ''}
      <div class="note">${esc(d.note)} The backtest so far loses after charges, so this is for paper-following only.</div>`;
  } catch (e) {
    $('bfToday').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('bfTodayBtn').disabled = false;
  }
});

// --- Strong-stock swing ---
const VARIANTS_COUNT = 24;
lazy('Strong-stock swing', async () => {
  try {
    const d = await api('/api/ath-swing');
    const b = d.backtest;
    const pc = (x, k = 0) => (x == null ? '–' : (x * 100).toFixed(k) + '%');
    const R = (x) => (x == null ? '–' : (x >= 0 ? '+' : '') + x.toFixed(2) + ' R');
    let html = '';
    if (b) {
      const row = (n, x) => !x?.trades ? '' : `<tr><td style="text-align:left">${esc(n)}</td><td>${x.trades}</td><td>${pc(x.winRate)}</td><td style="color:${x.avgR >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${R(x.avgR)}</b></td><td>${pc(x.avgRetPct, 1)}</td><td>${x.avgDays.toFixed(0)}</td><td>${x.profitFactor?.toFixed(2) ?? '–'}</td><td>${x.tStat?.toFixed(1) ?? '–'}</td></tr>`;
      const a = b.all;
      const pf = b.portfolio;
      html += `<div style="font-size:14px"><b>Backtest: ${b.stocks} stocks, ${esc(b.from)} → ${esc(b.to)}, after charges</b></div>
        <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Trades</th><th>Count</th><th>Won</th><th>Avg per trade</th><th>Avg return</th><th>Days held</th><th>Profit factor</th><th>t</th></tr></thead><tbody>
          ${row('All', a)}${row(`Before ${b.splitDate}`, b.firstHalf)}${row(`From ${b.splitDate}`, b.secondHalf)}${Object.entries(b.bySetup).map(([k, v]) => row(k, v)).join('')}</tbody></table></div>
        <table style="font-size:13px"><tbody>
          <tr><td>Portfolio (1% risk a trade, ≤10 open, idle cash at ${pf.cashRatePct}%)</td><td><b>${pc(pf.cagr, 1)} a year</b> vs NIFTY ${pc(pf.niftyCagr, 1)} · worst fall ${pc(pf.maxDrawdown)} · invested ${pc(pf.timeInMarket)} of the time</td></tr>
          <tr><td>Flag breakouts only</td><td>${pc(pf.flagOnly.cagr, 1)} a year · worst fall ${pc(pf.flagOnly.maxDrawdown)} · invested ${pc(pf.flagOnly.timeInMarket)}</td></tr>
          <tr><td>"90% of profit from 10% of trades"?</td><td>The best 10% of trades made <b>${pc(a.top10ShareOfR)}</b> of the total net result${a.top10ShareOfR > 1 ? ' — the other 90% lost money together. The big winners carry everything, as the trader says.' : '.'} Best trade ${R(a.bestR)}, median ${R(a.medianR)}.</td></tr>
          <tr><td>Losing streaks</td><td>Longest run of losses: <b>${a.longestLosingStreak}</b> in a row. With a ${pc(a.winRate)} win rate over ${a.trades} trades, a streak that long happens by chance ${pc(a.streakProbability)} of the time${a.streakProbability < 0.05 ? ' — unusually long, a sign the edge may be weaker than the win rate suggests' : ''}.</td></tr>
        </tbody></table>
        <div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px"><b>Verdict:</b> slightly positive per trade (${R(a.avgR)}, t ${a.tStat?.toFixed(1)}), not statistically reliable. Flag breakouts did best; oversold-base breakouts about broke even. As a portfolio it trailed simply holding NIFTY, but with far smaller falls. The stock list is today's NIFTY 200, which flatters the result (stocks that collapsed are missing). Paper-tracked from ${esc(d.paper?.startedAt || 'today')}.</div>
        ${(() => {
          const im = b.improve;
          if (!im) return '';
          const k = im.pick;
          const at = b.afterTax;
          const mixT = (list) => `<table style="font-size:12px"><thead><tr><th style="text-align:left">NIFTY fund / strategy</th><th>Per year</th><th>Worst year</th><th>Deepest fall</th></tr></thead><tbody>${list.map((m) => `<tr><td style="text-align:left">${m.indexPct}% / ${m.strategyPct}%</td><td>${pc(m.cagr, 1)}</td><td>${pc(m.worstYear, 1)}</td><td>${pc(m.maxDrawdown)}</td></tr>`).join('')}</tbody></table>`;
          return `<div style="margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid ${k.adopt ? 'var(--up)' : 'var(--line)'}">
            <div style="font-size:14px"><b>Improvement test</b> (${VARIANTS_COUNT} versions scored on trades before ${esc(b.splitDate)}, then judged on later trades and on ${b.wideStocks} NIFTY 500 stocks never used)</div>
            <div style="font-size:13px;margin-top:4px">Best on the first half: <b>${esc(k.name)}</b>. Later trades: ${R(k.test.avgR)} (t ${k.test.tStat?.toFixed(1)}) · other NIFTY 500 stocks: ${R(k.wideTest.avgR)} (t ${k.wideTest.tStat?.toFixed(1)}) · combined t ${k.combined.tStat?.toFixed(1)} →
              <b style="color:${k.adopt ? 'var(--up)' : 'var(--muted)'}">${k.adopt ? 'ADOPTED: the live scan now uses these rules' : 'not adopted'}</b>${k.adopt ? ` · portfolio ${pc(k.portfolioCagr, 1)} a year, worst fall ${pc(k.portfolioMaxDrawdown)}` : ''}.</div>
            ${im.marketFilter ? `<div class="note">Market filter (trade only while NIFTY is above its 200-day average): ${R(im.marketFilter.train.avgR)} on the first half, ${R(im.marketFilter.test.avgR)} on the second — it did not help, so it is not used.</div>` : ''}
            <div class="note">Original rules on ${b.wide.stocks} NIFTY 500 stocks outside the NIFTY 200: ${R(b.wide.base.avgR)} per trade (t ${b.wide.base.tStat?.toFixed(1)}) — the edge is not limited to the biggest companies.</div>
            <div class="note">${esc(im.rule)}</div>
          </div>
          <div style="font-size:14px;margin-top:10px"><b>After tax</b> (₹10 lakh, ${esc(b.from)} → ${esc(b.to)})</div>
          <table style="font-size:12px"><thead><tr><th style="text-align:left"></th><th>Before tax</th><th>After tax</th></tr></thead><tbody>
            <tr><td style="text-align:left">Strategy, original rules</td><td>${pc(at.strategy.cagrPre, 1)} a year</td><td><b>${pc(at.strategy.cagrAfter, 1)}</b></td></tr>
            ${at.improved ? `<tr><td style="text-align:left">Strategy, improved rules</td><td>${pc(at.improved.cagrPre, 1)} a year</td><td><b>${pc(at.improved.cagrAfter, 1)}</b></td></tr>` : ''}
            <tr><td style="text-align:left">NIFTY index fund, held throughout</td><td>${pc(at.index.cagrPre, 1)} a year</td><td><b>${pc(at.index.cagrAfter, 1)}</b></td></tr></tbody></table>
          <div class="note">${esc(at.note)}</div>
          <div style="font-size:14px;margin-top:10px"><b>Core + satellite</b>: part NIFTY fund, part strategy, rebalanced yearly (${b.coreSatellite.years} calendar years)</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">
            <div style="min-width:0"><div class="note">With the original rules</div>${mixT(b.coreSatellite.mixes)}</div>
            ${b.coreSatellite.mixesPick ? `<div style="min-width:0"><div class="note">With the improved rules</div>${mixT(b.coreSatellite.mixesPick)}</div>` : ''}
          </div>
          <div class="note">${esc(b.coreSatellite.note)} Adding a slice of the strategy mainly makes the bad years milder; it barely changes the long-run return.</div>`;
        })()}
        <details><summary style="cursor:pointer;font-size:13px">By year</summary><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Year</th><th>Trades</th><th>Won</th><th>Avg per trade</th></tr></thead><tbody>${Object.entries(b.byYear).map(([y, v]) => `<tr><td style="text-align:left">${esc(y)}</td><td>${v.trades}</td><td>${pc(v.winRate)}</td><td style="color:${v.avgR >= 0 ? 'var(--up)' : 'var(--down)'}">${R(v.avgR)}</td></tr>`).join('')}</tbody></table></div></details>`;
    } else html += '<div class="note">Backtest not run yet (the weekly refit runs it).</div>';
    const sv = d.survivorship;
    if (sv) {
      const o = sv.results.original;
      const im = sv.results.improved;
      const lineS = (n, x) => `<tr><td style="text-align:left">${esc(n)}</td><td>${x.all.trades}</td><td>${pc(x.all.winRate)}</td><td style="color:${x.all.avgR >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${R(x.all.avgR)}</b></td><td>${x.all.tStat?.toFixed(1) ?? '–'}</td><td>${R(x.firstHalf.avgR)} / ${R(x.secondHalf.avgR)}</td><td>${x.inLaterGoneStocks.trades ? `${x.inLaterGoneStocks.trades} trades, ${R(x.inLaterGoneStocks.avgR)}` : '–'}</td><td>${pc(x.portfolioCagr, 1)}</td></tr>`;
      const keeps = im && im.all.avgR > 0 && im.all.tStat >= 2;
      html += `<div style="margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid ${keeps ? 'var(--up)' : 'var(--warn)'}">
        <div style="font-size:14px"><b>Survivorship check</b>: the stocks as they really were each month (${esc(sv.from)} → ${esc(sv.to)})</div>
        <div class="note">${sv.stocksEverInUniverse} stocks were among the 200 most traded at some point; ${sv.laterGone} of them later stopped trading (collapsed, suspended, delisted or renamed). The main backtest above could not include those.</div>
        <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Rules</th><th>Trades</th><th>Won</th><th>Avg per trade</th><th>t</th><th>First / second half</th><th>In stocks that later disappeared</th><th>Portfolio per year</th></tr></thead><tbody>
          ${lineS('Original', o)}${im ? lineS('Improved (in use)', im) : ''}</tbody></table></div>
        <div style="font-size:13px;margin-top:6px"><b>${keeps ? 'The improved rules hold up without survivorship bias.' : 'Without survivorship bias the result is weaker than the main backtest — treat the strategy with extra caution.'}</b></div>
        <div class="note">${esc(sv.note)}</div></div>`;
    }
    const p = d.paper;
    if (p) html += `<div style="font-size:14px;margin-top:10px"><b>Paper record</b> since ${esc(p.startedAt)} (original and improved rules side by side): ${Object.entries(p.byVersion || {}).map(([v, x]) => `${esc(v)}: ${x.trades ? `${x.trades} closed · won ${pc(x.winRate)} · ${R(x.avgR)}` : 'no closed trades yet'}`).join(' · ') || 'no trades yet'}${p.open.length ? ` · open: ${p.open.map((t) => `${esc(t.symbol.replace('.NS', ''))} (${esc(t.version || 'original')}, trailing stop ${t.trail?.toFixed(1) ?? '–'})`).join(', ')}` : ''}. Updated after each close; a Mac notification lists new signals and exits, and the open positions' trailing stops are set as price alerts in My trades.</div>`;
    html += `<div class="note">${esc(b?.note || '')}</div>`;
    $('athOut').innerHTML = html;
  } catch (e) {
    $('athOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
function planFrom(t) {
  $('plSym').value = t.symbol.replace('.NS', '');
  $('plSide').value = 'long';
  $('plProduct').value = 'delivery';
  $('plSetup').value = 'Breakout';
  $('plEntry').value = t.close.toFixed(2);
  $('plStop').value = t.stop.toFixed(2);
  $('plTarget').value = '';
  showView('trades');
  $('planCard').scrollIntoView({ behavior: 'smooth' });
  $('plBtn').click();
}
$('athScanBtn').addEventListener('click', async () => {
  $('athScanBtn').disabled = true;
  $('athScan').innerHTML = '<div class="note">Scanning NIFTY 200 on completed daily candles (about 20 seconds)…</div>';
  try {
    const d = await api('/api/ath-swing/scan');
    let html = `<div style="font-size:14px"><b>Latest completed day: ${esc(d.date)}</b> · ${d.strongCount} of ${d.universe} stocks are structurally strong</div>
      <div class="note">Rules in use: ${d.rules?.improved ? '<b>improved</b> (adopted by the improvement test)' : 'original'} · stop ${d.rules?.stopAtr ?? 1} ATR below the low · trailing stop ${d.rules?.chandelierAtr ?? 3} ATR below the highest high · ${d.rules?.setups === 'flag' ? 'flag breakouts only' : 'base and flag breakouts'}</div>`;
    html += d.triggered.length ? `<div style="font-size:14px;margin-top:8px;color:var(--up)"><b>Signals: breakout at the close (${d.triggered.length})</b></div><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Setup</th><th>Close</th><th>Breakout level</th><th>Stop (1 ATR below the low)</th><th>Risk</th><th>Trailing stop now</th><th></th></tr></thead><tbody>${d.triggered.map((t, i) =>
      `<tr><td style="text-align:left"><b>${esc(t.symbol.replace('.NS', ''))}</b></td><td>${esc(t.setup)}</td><td>${t.close.toFixed(1)}</td><td>${t.trigger.toFixed(1)}</td><td>${t.stop.toFixed(1)}</td><td>${t.riskPct.toFixed(1)}%</td><td>${t.chandelier.toFixed(1)}</td><td>${t.held ? '<span style="color:var(--muted)">Already held on paper</span>' : `<button type="button" data-plan="${i}" style="margin:0;padding:3px 10px">Plan this trade</button>`}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">The rules buy at the next session's open. "Plan this trade" opens My trades with the stock, entry and stop filled in so you can see the share count and charges. "Already held on paper" means the paper record bought this stock earlier and is still holding it, so the rules take no second buy.</div>` : '<div class="note" style="margin-top:6px">No breakout signals at the latest close.</div>';
    if (d.forming.length) html += `<div style="font-size:13px;margin-top:8px"><b>Watch: oversold strong stocks (${d.forming.length})</b> — waiting for a base and a breakout: ${d.forming.map((x) => esc(x.symbol.replace('.NS', ''))).join(', ')}</div>`;
    html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px">Strong stocks closest to their all-time high (${d.strong.length})</summary><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Close</th><th>All-time high</th><th>Below it</th><th>ATH made</th><th>Weekly RSI</th></tr></thead><tbody>${d.strong.map((x) =>
      `<tr><td style="text-align:left">${esc(x.symbol.replace('.NS', ''))}</td><td>${x.close.toFixed(1)}</td><td>${x.ath.toFixed(1)}</td><td>${x.fromAthPct.toFixed(1)}%</td><td>${x.athDaysAgo} sessions ago</td><td>${x.weeklyRsi?.toFixed(0) ?? '–'}</td></tr>`).join('')}</tbody></table></div></details>
      <div class="note">${esc(d.note)}</div>`;
    $('athScan').innerHTML = html;
    $('athScan').querySelectorAll('button[data-plan]').forEach((btn) => btn.addEventListener('click', () => planFrom(d.triggered[+btn.dataset.plan])));
  } catch (e) {
    $('athScan').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('athScanBtn').disabled = false;
  }
});

// --- Phone access ---
async function lanLoad(msg = '') {
  try {
    const d = await api('/api/lan');
    $('lanOn').checked = d.enabled;
    $('lanOut').innerHTML = (msg ? `<b>${esc(msg)}</b><br>` : '') + (d.running
      ? `<b style="color:var(--up)">On.</b> On your phone (same Wi-Fi) open: ${d.urls.map((u) => `<b>${esc(u)}</b>`).join(' or ') || '(no home-network address found)'} and enter the PIN.`
      : `Off.${d.hasPin ? ' A PIN is set.' : ' Set a PIN to turn it on.'}${d.urls.length ? ` This Mac's home-network address: ${d.urls.map(esc).join(', ')}` : ''}`);
  } catch (e) {
    $('lanOut').innerHTML = location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? `<span class="err">${esc(e.message)}</span>` : 'These settings can be changed only on the Mac. <a href="/logout">Log out</a>';
  }
}
$('lanSave').addEventListener('click', async () => {
  try {
    const r = await api('/api/lan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: $('lanOn').checked, pin: $('lanPin').value }) });
    $('lanPin').value = '';
    if (r.restarting) {
      $('lanOut').textContent = 'Saved. Restarting the app…';
      setTimeout(() => lanLoad('Saved.'), 13000);
    } else lanLoad('Saved.');
  } catch (e) {
    $('lanOut').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
});
lazy('Phone access', lanLoad);
