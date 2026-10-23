// 15-fno-spreads.js — Trading strategies → F&O spreads (specification document): backtests and the real-price check.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const fnPc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const fnCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
const FN_NAMES = { 'momentum-debit': 'Momentum debit spreads', 'ivrank-credit': 'IV-rank credit spreads' };

function fnRender(d) {
  const b = d.backtest;
  let html = '';
  if (b) {
    const rc = b.realCheck;
    const md = b.runs?.spec2y?.results?.['momentum-debit'];
    const ic = b.runs?.spec2y?.results?.['ivrank-credit'];
    html += `<div style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid var(--warn);font-size:13px"><b>Verdict.</b>
      <b>Momentum debit spreads</b> did not make money in any check (last 2 years ${fnPc(md?.returnPct)}, profit factor ${md?.profitFactor?.toFixed(2) ?? '–'}; earlier years a large loss).
      <b>IV-rank credit spreads</b> look profitable <i>inside the model</i> (${fnPc(ic?.returnPct)} over 2 years, ${Math.round((ic?.winRate || 0) * 100)}% wins), but the model assumes options are priced from recent realised volatility.
      ${rc ? `On real NSE NIFTY prices, when volatility was high the market priced options about <b>${Math.round((1 - rc.ivRatioHighRank) * 100)}% cheaper</b> than the model, the real credit received was only <b>${Math.round(rc.credit.realOverModelCredit * 100)}%</b> of the model's, and the same credit logic with real prices <b>lost money</b> (${rc.credit.trades} trades, ${Math.round(rc.credit.winRate * 100)}% won, ${rc.credit.avgR?.toFixed(2)} R a trade, profit factor ${rc.credit.profitFactor?.toFixed(2)}).` : ''}
      With real NSE lot sizes, ₹1 lakh cannot hold even one lot at 1% risk; at ₹10 lakh both logics lost after charges. Neither is a trading edge. Kept here as a research result; it is not tracked on paper, because a model-priced record could only repeat what the model already says.</div>`;
    const head = '<tr><th style="text-align:left">Check</th><th>Strategy</th><th>Trades</th><th>Return</th><th>Won</th><th>Profit factor</th><th>Worst fall</th><th>t</th></tr>';
    const rows = Object.values(b.runs || {}).flatMap((run) => Object.entries(run.results).map(([k, x], i) =>
      `<tr><td style="text-align:left">${i === 0 ? esc(run.label) : ''}</td><td>${esc(FN_NAMES[k] || k)}</td><td>${x.trades}</td><td style="color:${fnCol(x.returnPct)}"><b>${x.trades ? fnPc(x.returnPct) : '–'}</b></td><td>${x.winRate != null ? Math.round(x.winRate * 100) + '%' : '–'}</td><td>${x.profitFactor?.toFixed(2) ?? '–'}</td><td>${x.trades ? x.maxDrawdownPct.toFixed(1) + '%' : '–'}</td><td>${x.tStat?.toFixed(2) ?? '–'}</td></tr>`)).join('');
    html += `<div style="font-size:14px"><b>Backtests</b> (₹1 lakh start, data to ${esc(b.to)})</div><div style="overflow-x:auto"><table style="font-size:12px"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
    if (rc) html += `<div class="note">Real-price check: ${esc(rc.note)} ${rc.weeks} weeks compared.</div>`;
    html += `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:13px">Choices made where the document is silent</summary><ul style="margin:4px 0 0 18px;font-size:12px">${(b.assumptions || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul></details>
      <div class="note">${esc(b.caveat)}</div>`;
  } else html += '<div class="note">Backtests not run yet: press Re-run backtests.</div>';
  $('fnoOut').innerHTML = html;
}
lazy('F&O spreads', async () => {
  try { fnRender(await api('/api/fno-spreads')); } catch (e) { $('fnoOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
$('fnoRunBtn').addEventListener('click', async () => {
  $('fnoRunBtn').disabled = true;
  $('fnoOut').innerHTML = '<div class="note">Re-running the backtests and the real-price check…</div>';
  try {
    const r = await api('/api/fno-spreads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    fnRender({ ...(await api('/api/fno-spreads')), backtest: r.backtest });
  } catch (e) { $('fnoOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; } finally { $('fnoRunBtn').disabled = false; }
});
