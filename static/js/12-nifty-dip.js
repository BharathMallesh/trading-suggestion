// 12-nifty-dip.js — Trading strategies → NIFTY dip-buy: where NIFTY stands, backtest, paper record.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const dipRs = (v) => (v == null ? '–' : (v < 0 ? '−₹' : '+₹') + Math.abs(Math.round(v)).toLocaleString('en-IN'));
const dipPc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const dipYr = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);

function dipTodayHtml(t) {
  if (!t) return '<div class="note">NIFTY status unavailable right now.</div>';
  const col = t.position ? 'var(--accent)' : t.pendingBuy ? 'var(--up)' : 'var(--muted)';
  return `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);border-left:4px solid ${col}">
    <div style="font-size:14px"><b>${esc(t.message)}</b></div>
    <div class="kv" style="margin-top:6px">
      <div>NIFTY close (${esc(t.date)})</div><div>${t.close.toFixed(0)}</div>
      <div>200-day average</div><div>${t.ma200.toFixed(0)} · NIFTY is <b style="color:${t.aboveMa ? 'var(--up)' : 'var(--down)'}">${t.aboveMa ? 'above (dips can be bought)' : 'below (no buying)'}</b></div>
      <div>Change over 5 sessions</div><div>${dipPc(t.changePct)} (needs −3.0% or worse)</div>
      ${t.position ? `<div>Paper position</div><div>bought ${esc(t.position.entryDate)} at ${t.position.entry.toFixed(0)} · now ${dipPc(t.position.retPct, 2)} (${dipRs(t.position.netRs)} after costs) · day ${t.position.days}</div>` : ''}
    </div></div>`;
}

function dipRender(d) {
  $('dipToday').innerHTML = dipTodayHtml(d.today);
  const b = d.backtest;
  let html = '';
  if (b) {
    const row = (n, x) => !x?.trades ? '' : `<tr><td style="text-align:left">${esc(n)}</td><td>${x.trades}</td><td><b>${Math.round(x.winRate * 100)}%</b></td><td style="color:${x.avgRetPct >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${dipPc(x.avgRetPct, 2)}</b> (${dipRs(x.avgNetRs)})</td><td>${dipPc(x.worstPct)}</td><td>${x.profitFactor?.toFixed(2) ?? '–'}</td><td>${x.maxDrawdownPct.toFixed(1)}%</td><td>${x.avgDays.toFixed(1)}</td><td>${x.tStat?.toFixed(2) ?? '–'}</td></tr>`;
    const p = b.portfolio;
    html += `<div style="font-size:14px"><b>Backtest on NIFTY, ${esc(b.from)} → ${esc(b.to)}</b> · ₹1 lakh a trade, after ETF charges and slippage</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Period</th><th>Trades</th><th>Won</th><th>Avg a trade</th><th>Worst trade</th><th>Profit factor</th><th>Worst fall</th><th>Days held</th><th>t</th></tr></thead><tbody>
        ${row('2010–2018 (rules chosen here)', b.train)}${row('2019 onward (honest test)', b.test)}</tbody></table></div>`;
    if (p) html += `<div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px"><b>Verdict:</b> since 2019 it won <b>${Math.round(b.test.winRate * 100)}%</b> of ${b.test.trades} trades (about ${b.perYear} a year), but it was in the market only <b>${p.timeInMarketPct.toFixed(0)}%</b> of the time.
      With idle cash in a liquid fund it made <b>${dipYr(p.cagr)}</b> a year (<b>${dipYr(p.cagrAfter)}</b> after tax) against <b>${dipYr(p.niftyCagr)}</b> (${dipYr(p.niftyAfter)} after tax) for simply holding NIFTY.
      A high win rate is not the same as a high return: an index fund did better. Kept on paper for learning.</div>`;
    if (b.recent?.length) html += `<details><summary style="cursor:pointer;font-size:13px">Recent backtest trades (${b.recent.length})</summary><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Bought</th><th>NIFTY fall before</th><th>Sold</th><th>Days</th><th>Why sold</th><th>Result</th></tr></thead><tbody>${b.recent.map((t) =>
      `<tr><td style="text-align:left">${esc(t.entryDate)}</td><td>${dipPc(t.signalChangePct)}</td><td>${esc(t.exitDate)}</td><td>${t.days}</td><td>${t.reason === 'bounce' ? 'Bounce' : '10-day limit'}</td><td style="color:${t.net >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${dipPc(t.retPct, 2)}</b> (${dipRs(t.net)})</td></tr>`).join('')}</tbody></table></div></details>`;
    html += `<div class="note">${esc(b.note)}</div>`;
  } else html += '<div class="note">Backtest not run yet: press Re-run backtest.</div>';
  const pp = d.paper;
  if (pp) {
    html += `<div style="font-size:14px;margin-top:10px"><b>Paper record</b> since ${esc(pp.startedAt)}: ${pp.summary.trades ? `${pp.summary.trades} closed · won ${Math.round(pp.summary.winRate * 100)}% · total ${dipRs(pp.summary.totalNetRs)}` : 'no closed trades yet (about 3 a year, recorded after each close)'}</div>`;
    if (pp.trades.length) html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Bought</th><th>Price</th><th>Sold</th><th>Days</th><th>Status</th><th>Result</th></tr></thead><tbody>${pp.trades.map((t) =>
      `<tr><td style="text-align:left">${esc(t.entryDate)}</td><td>${t.entry.toFixed(0)}</td><td>${esc(t.exitDate || '–')}</td><td>${t.days}</td><td>${t.open ? 'Holding' : t.reason === 'bounce' ? 'Sold on bounce' : 'Sold at 10 days'}</td><td style="color:${t.net >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${dipPc(t.retPct, 2)}</b> (${dipRs(t.net)})</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('dipOut').innerHTML = html;
}
lazy('NIFTY dip-buy', async () => {
  try { dipRender(await api('/api/nifty-dip')); } catch (e) { $('dipOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
$('dipRunBtn').addEventListener('click', async () => {
  $('dipRunBtn').disabled = true;
  $('dipOut').innerHTML = '<div class="note">Re-running on NIFTY daily closes since 2007…</div>';
  try {
    const r = await api('/api/nifty-dip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    dipRender({ ...(await api('/api/nifty-dip')), backtest: r.backtest });
  } catch (e) { $('dipOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; } finally { $('dipRunBtn').disabled = false; }
});
