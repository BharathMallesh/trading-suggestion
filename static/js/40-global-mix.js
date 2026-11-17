// 40-global-mix.js — Investing → Global mix: ⅓ Momentum 10 / ⅓ Nasdaq-100 (MON100) / ⅓ gold paper portfolio,
// with the loop-11 research and its cautions. Classic script (not a module): loaded in order by index.html.
const gmAmt = (v) => `₹${Math.round(v || 0).toLocaleString('en-IN')}`;
const gmPc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const gmCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');

function gmRender(d) {
  const p = d.paper;
  const R = d.research;
  let html = '';
  if (p?.rebalances?.length) {
    const cur = p.rebalances.at(-1);
    const value = p.curve.at(-1)?.value ?? p.capital;
    html += `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px"><b>Paper portfolio ${gmAmt(value)}</b> <span style="color:${gmCol(value - p.capital)}">(${gmPc(value / p.capital - 1, 2)})</span> from ${gmAmt(p.capital)} on ${esc(p.startedAt)} · ${p.rebalances.length} month-end${p.rebalances.length === 1 ? '' : 's'}</div>`;
    if (cur.weightsBefore) {
      const w = cur.weightsBefore;
      html += `<div class="note">Last month-end (${esc(cur.monthEnd)}): Nasdaq ${gmPc(w.nasdaq, 0)} · gold ${gmPc(w.gold, 0)} · stocks ${gmPc(w.stocks, 0)} — ${cur.putBackToThirds ? '<b>put back to ⅓ each</b>' : 'all within 5 points of ⅓, left as they were (the stock part follows the new Momentum 10 list)'}.</div>`;
    }
    if (p.marks?.length) html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Holding</th><th>Amount at re-balance</th><th>Entry</th><th>Last</th><th>Result</th></tr></thead><tbody>${p.marks.map((x) => `<tr><td style="text-align:left">${esc(x.name)}</td><td>${gmAmt(x.amount)}</td><td>${x.entry ? `₹${x.entry.toFixed(1)}` : '–'}</td><td>${x.last ? `₹${x.last.toFixed(1)}` : '–'}</td><td style="color:${gmCol(x.retPct)}">${x.retPct >= 0 ? '+' : ''}${x.retPct.toFixed(2)}%</td></tr>`).join('')}</tbody></table></div>`;
  } else html += `<div class="note">Paper portfolio (₹1,00,000) starts at the first session after the next month-end${p?.startedAt ? ` (record opened ${esc(p.startedAt)})` : ''}: ⅓ MON100, ⅓ GOLDBEES, ⅓ that month's Momentum 10 list.</div>`;
  if (R) {
    html += `<div style="font-size:14px;margin-top:12px"><b>How it was tested</b> — ${esc(R.period)}</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left"></th><th>A year, after tax</th><th>Worst fall</th></tr></thead><tbody>${R.rows.map((x, i) =>
        `<tr><td style="text-align:left">${i ? '' : '<b>'}${esc(x.label)}${i ? '' : '</b>'}</td><td>${gmPc(x.cagr)}</td><td style="color:var(--down)">${(x.dd * 100).toFixed(0)}%</td></tr>`).join('')}</tbody></table></div>
      <div style="overflow-x:auto;margin-top:6px"><table style="font-size:12px"><thead><tr><th style="text-align:left">Crisis</th><th>NIFTY</th><th>Nasdaq (₹)</th><th>Global mix</th><th>India mix</th></tr></thead><tbody>${R.crises.map((c) =>
        `<tr><td style="text-align:left">${esc(c.when)}</td><td style="color:${gmCol(c.nifty)}">${gmPc(c.nifty, 0)}</td><td style="color:${gmCol(c.nasdaq)}">${gmPc(c.nasdaq, 0)}</td><td style="color:${gmCol(c.mix)}">${gmPc(c.mix, 1)}</td><td style="color:${gmCol(c.india)}">${gmPc(c.india, 1)}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">Verdict: ${esc(R.verdict)}. US shares in rupees helped in India-only and rupee crises, not in global ones. MON100 has traded 10–24% above its fair value at times — check its premium (iNAV) before buying. Taxed as a non-equity fund. Not advice.</div>`;
  }
  $('globalOut').innerHTML = html;
}
lazy('Global mix', async () => {
  try { gmRender(await api('/api/global-mix')); } catch (e) { $('globalOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
