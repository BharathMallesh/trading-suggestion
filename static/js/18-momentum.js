// 18-momentum.js — Investing → Momentum 20 (screen): the tested record, this month's list, the paper portfolio.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const mPc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const mCol = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');

function momRender(d) {
  const b = d.backtest;
  const p = d.paper;
  let html = '';
  if (b) {
    const c = b.methods[b.chosen];
    html += `<div style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid ${b.passed ? 'var(--up)' : 'var(--warn)'};font-size:13px"><b>${b.passed ? 'Passed the honest test' : 'Did not pass'}.</b> ${esc(b.verdict)}
      <div class="note" style="margin:4px 0 0">Expect less in practice: the test fills every trade at the open with no market impact. NSE's real NIFTY 200 Momentum 30 index made ${b.nse?.find((x) => x.key === 'momentum30') ? mPc(b.nse.find((x) => x.key === 'momentum30').cagr) : '–'} a year since Aug 2020 — a momentum <b>index fund</b> does a similar job with far less effort and tax.</div></div>`;
    html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Method</th><th>Per year</th><th>After tax</th><th>2010–17</th><th>2018 →</th><th>Worst fall</th><th>Trading a year</th></tr></thead><tbody>${Object.entries(b.methods).map(([k, m]) =>
      `<tr><td style="text-align:left">${k === b.chosen ? '<b>' : ''}${esc(m.label)}${k === b.chosen ? '</b> (chosen on 2010–17)' : ''}</td><td>${mPc(m.cagr)}</td><td>${mPc(m.cagrAfterTax)}</td><td>${mPc(m.early)}</td><td>${mPc(m.late)}</td><td>${mPc(-m.maxDrawdown).replace('+', '')}</td><td>${Math.round(m.turnoverPerYear * 100)}% of the money</td></tr>`).join('')}
      <tr><td style="text-align:left">NIFTY index fund (total return)</td><td>${mPc(b.index.cagr)}</td><td>${mPc(b.index.cagrAfterTax)}</td><td>${mPc(b.index.early)}</td><td>${mPc(b.index.late)}</td><td>${mPc(-b.index.maxDrawdown).replace('+', '')}</td><td>–</td></tr></tbody></table></div>`;
    const years = Object.keys(c.yearly);
    html += `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:13px">Year by year (the bad years matter)</summary><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Year</th><th>Momentum 20</th><th>NIFTY</th></tr></thead><tbody>${years.map((y) =>
      `<tr><td style="text-align:left">${esc(y)}</td><td style="color:${mCol(c.yearly[y])}">${mPc(c.yearly[y])}</td><td style="color:${mCol(b.index.yearly?.[y])}">${mPc(b.index.yearly?.[y])}</td></tr>`).join('')}</tbody></table></div></details>
      <div class="note">${esc(b.note)}</div>`;
  } else html += '<div class="note">Backtest not run yet (it runs with the Saturday re-tests).</div>';
  if (p?.list?.length) {
    html += `<div style="font-size:14px;margin-top:12px"><b>This month's list</b> (ranked at the ${esc(p.monthEnd)} close; the next list is made after this month ends)</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">#</th><th style="text-align:left">Stock</th><th>12-month change</th><th>Yearly volatility</th><th>Close then</th></tr></thead><tbody>${p.list.map((x) =>
        `<tr><td style="text-align:left">${x.rank}</td><td style="text-align:left"><b>${esc(x.symbol)}</b></td><td style="color:${mCol(x.ret12)}">${mPc(x.ret12, 0)}</td><td>${x.vol != null ? `${(x.vol * 100).toFixed(0)}%` : '–'}</td><td>₹${x.close.toFixed(1)}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">Equal amounts in each (₹1 lakh → about ₹5,000 a stock). These stocks have already risen a lot; momentum keeps them only while they stay strong, and swaps out the ones that weaken at each month-end. Expect big swings (yearly volatility of 40–60% each).</div>`;
    if (p.preview?.list?.length) html += `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:13px">Preview: the list if the month ended on ${esc(p.preview.date)}</summary><div style="font-size:12px;margin-top:4px">${p.preview.list.map((x) => esc(x.symbol)).join(' · ')}</div></details>`;
  }
  if (p) {
    const last = p.curve?.at(-1);
    html += `<div style="font-size:14px;margin-top:12px"><b>Paper portfolio</b> since ${esc(p.startedAt)}: ${p.rebalances?.length ? `${p.rebalances.length} rebalance${p.rebalances.length > 1 ? 's' : ''} · value ₹${Math.round(last?.value ?? p.capital).toLocaleString('en-IN')} (${mPc((last?.value ?? p.capital) / p.capital - 1, 2)})` : 'starts with the first list made after this month ends (bought at the next open)'}</div>`;
    if (p.marks?.length) html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Bought at</th><th>Last close</th><th>Change</th></tr></thead><tbody>${p.marks.map((m) =>
      `<tr><td style="text-align:left">${esc(m.symbol)}</td><td>₹${m.entry.toFixed(1)}</td><td>${m.last ? `₹${m.last.toFixed(1)}` : '–'}</td><td style="color:${mCol(m.retPct)}">${m.retPct >= 0 ? '+' : ''}${m.retPct.toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('momOut').innerHTML = html;
}
lazy('Momentum 20', async () => {
  try { momRender(await api('/api/momentum')); } catch (e) { $('momOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
