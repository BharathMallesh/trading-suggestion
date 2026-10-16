// 12-nifty-dip.js — Trading strategies → NIFTY dip-buy: where NIFTY stands, backtest, paper record.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const dipRs = (v) => (v == null ? '–' : (v < 0 ? '−₹' : '+₹') + Math.abs(Math.round(v)).toLocaleString('en-IN'));
const dipPc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const dipYr = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);

const DIP_LABELS = { standard: 'Standard: −3% in 5 days', deep: 'Deep dip: −5% in 10 days (about 1 trade a year)' };
const DIP_SHORT = { standard: 'Standard', deep: 'Deep dip' };
// older saved backtests / paper files have only the standard version
const dipVersions = (b) => b?.versions || (b ? { standard: b } : {});

function dipTodayHtml(t, label = null) {
  if (!t) return `<div class="note">${label ? `${esc(label)}: ` : ''}NIFTY status unavailable right now.</div>`;
  const col = t.position ? 'var(--accent)' : t.pendingBuy ? 'var(--up)' : 'var(--muted)';
  const n = t.lookback ?? 5;
  return `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);border-left:4px solid ${col};margin-bottom:8px">
    ${label ? `<div style="font-size:12px;color:var(--muted)">${esc(label)}</div>` : ''}
    <div style="font-size:14px"><b>${esc(t.message)}</b></div>
    <div class="kv" style="margin-top:6px">
      <div>NIFTY close (${esc(t.date)})</div><div>${t.close.toFixed(0)}</div>
      <div>200-day average</div><div>${t.ma200.toFixed(0)} · NIFTY is <b style="color:${t.aboveMa ? 'var(--up)' : 'var(--down)'}">${t.aboveMa ? 'above (dips can be bought)' : 'below (no buying)'}</b></div>
      <div>Change over ${n} sessions</div><div>${dipPc(t.changePct)} (needs ${(t.dropPct ?? -3).toFixed(1).replace('-', '−')}% or worse)</div>
      ${t.position ? `<div>Paper position</div><div>bought ${esc(t.position.entryDate)} at ${t.position.entry.toFixed(0)} · now ${dipPc(t.position.retPct, 2)} (${dipRs(t.position.netRs)} after costs) · day ${t.position.days}</div>` : ''}
    </div></div>`;
}

const dipRecentHtml = (label, recent) => !recent?.length ? '' : `<details><summary style="cursor:pointer;font-size:13px">Recent backtest trades, ${esc(label)} (${recent.length})</summary><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Bought</th><th>NIFTY fall before</th><th>Sold</th><th>Days</th><th>Why sold</th><th>Result</th></tr></thead><tbody>${recent.map((t) =>
  `<tr><td style="text-align:left">${esc(t.entryDate)}</td><td>${dipPc(t.signalChangePct)}</td><td>${esc(t.exitDate)}</td><td>${t.days}</td><td>${t.reason === 'bounce' ? 'Bounce' : '10-day limit'}</td><td style="color:${t.net >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${dipPc(t.retPct, 2)}</b> (${dipRs(t.net)})</td></tr>`).join('')}</tbody></table></div></details>`;

function dipRender(d) {
  // where NIFTY stands, one box per version
  const tv = d.today?.versions || (d.today ? { standard: d.today } : null);
  $('dipToday').innerHTML = tv ? Object.entries(tv).map(([v, t]) => dipTodayHtml(t, DIP_LABELS[v] || v)).join('') : dipTodayHtml(null);
  const b = d.backtest;
  let html = '';
  if (b) {
    const vs = dipVersions(b);
    const row = (n, x) => !x?.trades ? '' : `<tr><td style="text-align:left">${esc(n)}</td><td>${x.trades}</td><td><b>${Math.round(x.winRate * 100)}%</b></td><td style="color:${x.avgRetPct >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${dipPc(x.avgRetPct, 2)}</b> (${dipRs(x.avgNetRs)})</td><td>${dipPc(x.worstPct)}</td><td>${x.profitFactor?.toFixed(2) ?? '–'}</td><td>${x.maxDrawdownPct.toFixed(1)}%</td><td>${x.avgDays.toFixed(1)}</td><td>${x.tStat?.toFixed(2) ?? '–'}</td></tr>`;
    html += `<div style="font-size:14px"><b>Backtest on NIFTY, ${esc(b.from)} → ${esc(b.to)}</b> · ₹1 lakh a trade, after ETF charges and slippage</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Version and period</th><th>Trades</th><th>Won</th><th>Avg a trade</th><th>Worst trade</th><th>Profit factor</th><th>Worst fall</th><th>Days held</th><th>t</th></tr></thead><tbody>
        ${Object.entries(vs).map(([v, x]) => row(`${DIP_SHORT[v] || v} · 2010–2018 (rules chosen here)`, x.train) + row(`${DIP_SHORT[v] || v} · 2019 onward (honest test)`, x.test)).join('')}</tbody></table></div>`;
    // yearly return since 2019, each version vs simply holding NIFTY
    const withP = Object.entries(vs).filter(([, x]) => x.portfolio);
    if (withP.length) {
      const p0 = withP[0][1].portfolio;
      html += `<div style="font-size:13px;margin-top:10px"><b>Per year since 2019</b> (idle cash in a liquid fund)</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Version</th><th>Trades a year</th><th>In the market</th><th>Per year</th><th>Per year after tax</th></tr></thead><tbody>
        ${withP.map(([v, x]) => `<tr><td style="text-align:left">${esc(DIP_LABELS[v] || v)}</td><td>${x.perYear}</td><td>${x.portfolio.timeInMarketPct.toFixed(0)}%</td><td>${dipYr(x.portfolio.cagr)}</td><td><b>${dipYr(x.portfolio.cagrAfter)}</b></td></tr>`).join('')}
        <tr><td style="text-align:left">Holding NIFTY instead</td><td>–</td><td>100%</td><td>${dipYr(p0.niftyCagr)}</td><td><b>${dipYr(p0.niftyAfter)}</b></td></tr></tbody></table></div>`;
    }
    const s = vs.standard;
    const dv = vs.deep;
    if (s?.portfolio && s.test?.trades) html += `<div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px"><b>Verdict:</b> since 2019 the standard version won <b>${Math.round(s.test.winRate * 100)}%</b> of ${s.test.trades} trades (about ${s.perYear} a year), but it was in the market only <b>${s.portfolio.timeInMarketPct.toFixed(0)}%</b> of the time
      and made <b>${dipYr(s.portfolio.cagrAfter)}</b> a year after tax against <b>${dipYr(s.portfolio.niftyAfter)}</b> for simply holding NIFTY.
      ${dv?.test?.trades && dv.portfolio ? `The deep-dip version won <b>${Math.round(dv.test.winRate * 100)}%</b> of ${dv.test.trades} trades (${dv.train?.trades ? `${Math.round(dv.train.winRate * 100)}% of ${dv.train.trades} in 2010–2018` : 'few earlier trades'}), but trades only about ${dv.perYear} times a year and made <b>${dipYr(dv.portfolio.cagrAfter)}</b> a year after tax.
      <b>Higher win rate, fewer trades, lower yearly return.</b> ` : ''}A high win rate is not the same as a high return: an index fund did better than both. Kept on paper for learning.</div>`;
    for (const [v, x] of Object.entries(vs)) html += dipRecentHtml(DIP_SHORT[v] || v, x.recent);
    html += `<div class="note">${esc(b.note)}</div>`;
  } else html += '<div class="note">Backtest not run yet: press Re-run backtest.</div>';
  const pp = d.paper;
  if (pp) {
    const byV = pp.byVersion || { standard: { summary: pp.summary } };
    const often = { standard: 'about 3 a year', deep: 'about 1 a year' };
    html += `<div style="font-size:14px;margin-top:10px"><b>Paper record</b> since ${esc(pp.startedAt)} (recorded after each close)</div><ul style="margin:4px 0 0 18px;padding:0;font-size:13px;line-height:1.6">${Object.entries(byV).map(([v, x]) =>
      `<li><b>${esc(DIP_LABELS[v] || v)}</b>: ${x.summary.trades ? `${x.summary.trades} closed · won ${Math.round(x.summary.winRate * 100)}% · total ${dipRs(x.summary.totalNetRs)}` : `no closed trades yet (${often[v] || 'rare'})`}</li>`).join('')}</ul>`;
    if (pp.trades.length) html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Bought</th><th>Version</th><th>Price</th><th>Sold</th><th>Days</th><th>Status</th><th>Result</th></tr></thead><tbody>${pp.trades.map((t) =>
      `<tr><td style="text-align:left">${esc(t.entryDate)}</td><td>${esc(DIP_SHORT[t.version || 'standard'] || t.version)}</td><td>${t.entry.toFixed(0)}</td><td>${esc(t.exitDate || '–')}</td><td>${t.days}</td><td>${t.open ? 'Holding' : t.reason === 'bounce' ? 'Sold on bounce' : 'Sold at 10 days'}</td><td style="color:${t.net >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${dipPc(t.retPct, 2)}</b> (${dipRs(t.net)})</td></tr>`).join('')}</tbody></table></div>`;
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
