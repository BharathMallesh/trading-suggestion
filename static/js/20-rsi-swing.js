// 20-rsi-swing.js — Trading strategies → RSI swing (oversold bounce): test, live scan, paper record.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const rsPc = (x, d = 2) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const rsCol = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');

function rsiRender(d) {
  const b = d.backtest;
  const p = d.paper;
  let html = '';
  if (b) {
    html += `<div style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid ${b.passed ? 'var(--up)' : 'var(--warn)'};font-size:13px"><b>${b.passed ? 'Passed' : 'Did not pass'}.</b> ${esc(b.verdict)}
      <div class="note" style="margin:4px 0 0">Before charges the buy setup was roughly break-even (about +0.5% a trade); the ~0.7% round-trip delivery cost of a 2–3 day trade turns it into a loss. The interview gave no measured win rate; its examples were picked by hand.</div></div>`;
    html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Version</th><th>Trades</th><th>Won</th><th>Per trade (after charges)</th><th>t</th><th>First year</th><th>Second year</th><th>Strong setups (hourly RSI &lt; 15)</th><th>₹1 lakh per year</th><th>Days held</th></tr></thead><tbody>${Object.values(b.results).map((x) =>
      `<tr><td style="text-align:left">${x.side === 'long' && x.version === b.chosen ? '<b>' : ''}${esc(x.label)}${x.side === 'long' && x.version === b.chosen ? '</b> (chosen on the first year)' : ''}</td><td>${x.all.trades}</td><td>${Math.round((x.all.winRate || 0) * 100)}%</td><td style="color:${rsCol(x.all.avgRetPct)}"><b>${rsPc(x.all.avgRetPct)}</b></td><td>${x.all.tStat?.toFixed(1) ?? '–'}</td><td style="color:${rsCol(x.first.avgRetPct)}">${rsPc(x.first.avgRetPct)}</td><td style="color:${rsCol(x.second.avgRetPct)}">${rsPc(x.second.avgRetPct)}</td><td>${rsPc(x.strong.avgRetPct)} (${x.strong.trades})</td><td style="color:${rsCol(x.portfolio.cagr)}">${x.portfolio.cagr != null ? rsPc(x.portfolio.cagr * 100, 1) : '–'}</td><td>${x.all.avgDays?.toFixed(1) ?? '–'}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">${b.stocks} stocks, ${esc(b.from)} → ${esc(b.to)} (split ${esc(b.split)}). NIFTY over the same span: ${b.nifty ? rsPc(b.nifty.cagr * 100, 1) : '–'} a year. The short versions need futures to hold overnight. ${esc(b.note)}</div>`;
    if (b.improve) {
      html += `<div style="font-size:14px;margin-top:12px"><b>Improvement test</b> (buy side; ${b.improve.tried} versions, chosen on the first year, judged once on the second)</div>
        <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Version</th><th>Trades</th><th>Won</th><th>Per trade (after charges)</th><th>Before charges</th><th>First year</th><th>Second year</th><th>₹1 lakh per year</th></tr></thead><tbody>${Object.entries(b.improve.results).map(([k, x]) =>
          `<tr><td style="text-align:left">${k === b.improve.pick ? '<b>' : ''}${esc(x.label)}${k === b.improve.pick ? '</b> (chosen on the first year)' : ''}</td><td>${x.all.trades}</td><td>${Math.round((x.all.winRate || 0) * 100)}%</td><td style="color:${rsCol(x.all.avgRetPct)}"><b>${rsPc(x.all.avgRetPct)}</b></td><td>${rsPc(x.beforeCosts.avgRetPct)}</td><td style="color:${rsCol(x.first.avgRetPct)}">${rsPc(x.first.avgRetPct)}</td><td style="color:${rsCol(x.second.avgRetPct)}">${rsPc(x.second.avgRetPct)} <span class="note" style="display:inline">(t ${x.second.tStat?.toFixed(1) ?? '–'})</span></td><td style="color:${rsCol(x.portfolio.cagr)}">${x.portfolio.cagr != null ? rsPc(x.portfolio.cagr * 100, 1) : '–'}</td></tr>`).join('')}</tbody></table></div>
        <div style="margin:6px 0;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px"><b>${b.improve.passed ? 'An improvement passed.' : 'No improvement passed.'}</b> ${esc(b.improve.verdict)} Before charges every version makes about +0.2% to +0.6% a trade, but a 2–3 day delivery trade costs about 0.7% (STT on both sides, charges, slippage) — more than the edge. Trend filters left fewer, weaker setups; the bounce exit raised the win rate (about 46%) but not the profit.</div>`;
    }
  } else html += '<div class="note">Backtest not run yet (it runs with the Saturday re-tests).</div>';
  if (p) {
    const s = p.scan || { triggered: [], forming: [] };
    html += `<div style="font-size:14px;margin-top:12px"><b>Live scan</b> (latest completed hourly candle)</div>
      <div style="font-size:13px">${s.triggered.length ? `Entry signals (buy at the next hourly open on paper): ${s.triggered.map((x) => `<b>${esc(x.symbol.replace('.NS', ''))}</b> stop ₹${x.stop.toFixed(1)}`).join(' · ')}` : 'No entry signal right now.'}</div>
      ${s.forming.length ? `<div class="note">Oversold now (daily RSI under 35; <b>bold</b> = both RSI conditions met, waiting for the green-candle entry): ${s.forming.map((x) => `${x.ready ? '<b>' : ''}${esc(x.symbol.replace('.NS', ''))} ${x.dailyRsi.toFixed(0)}/${x.hourlyRsi.toFixed(0)}${x.ready ? '</b>' : ''}`).join(' · ')} (daily/hourly RSI)</div>` : ''}
      <div style="font-size:14px;margin-top:10px"><b>Paper record</b> since ${esc(p.startedAt)} (${esc(b?.versions?.[p.version] || p.version)}): ${p.summary.trades ? `${p.summary.trades} closed · won ${Math.round(p.summary.winRate * 100)}% · ${rsPc(p.summary.avgRetPct)} a trade` : 'no closed trades yet'}${p.trades.some((t) => t.open) ? ` · open: ${p.trades.filter((t) => t.open).map((t) => esc(t.symbol.replace('.NS', ''))).join(', ')}` : ''}</div>`;
    if (p.trades.length) html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Entry</th><th>Stop</th><th>Exit</th><th>Why</th><th>Result</th></tr></thead><tbody>${p.trades.map((t) =>
      `<tr><td style="text-align:left">${esc(t.symbol.replace('.NS', ''))}</td><td>${esc(t.entryTime)}</td><td>₹${t.entry.toFixed(1)}</td><td>₹${t.stop.toFixed(1)}</td><td>${t.open ? '–' : `₹${t.exit.toFixed(1)}`}</td><td>${esc(t.reason)}</td><td style="color:${rsCol(t.retPct)}"><b>${rsPc(t.retPct * 100)}</b></td></tr>`).join('')}</tbody></table></div>`;
  }
  $('rsiOut').innerHTML = html;
}
lazy('RSI swing', async () => {
  try { rsiRender(await api('/api/rsi-swing')); } catch (e) { $('rsiOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
