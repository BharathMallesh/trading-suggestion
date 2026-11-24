// 49-finalist-two.js — Investing → Finalist 2 (heavier momentum): the loop-22 algo-search finalist (½ momentum stocks in
// two staggered tranches of 4 / ⅓ GOLDBEES / ⅙ JUNIORBEES), PAPER ONLY. It won 2010–22 but lost both never-seen
// periods to India mix, so it is tracked to see whether heavier momentum comes back. Classic script (not a module).
const f2Amt = (v) => `₹${Math.round(v || 0).toLocaleString('en-IN')}`;
const f2Pc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const f2Pct = (x, d = 2) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const f2Col = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
const f2Day = (d) => {
  if (!d) return '–';
  const t = new Date(`${d}T00:00:00Z`);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()]} ${t.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()]} ${t.getUTCFullYear()}`;
};
const F2_PART = { S1: 'Tranche 1', S2: 'Tranche 2', GOLD: 'Gold ⅓', NN50: 'Next 50 ⅙' };

function f2Render(d) {
  const p = d.paper;
  const c = d.compare;
  const R = d.research;
  let html = '';
  if (p?.rebalances?.length) {
    const value = p.curve?.at(-1)?.value ?? p.capital;
    html += `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px"><b>Paper portfolio ${f2Amt(value)}</b> <span style="color:${f2Col(value - p.capital)}">(${f2Pc(value / p.capital - 1, 2)})</span> from ${f2Amt(p.capital)} · ${p.rebalances.length} month-end${p.rebalances.length === 1 ? '' : 's'} · data to ${esc(p.dataTo || '–')}</div>`;
    if (c) {
      html += `<div style="overflow-x:auto;margin-top:6px"><table style="font-size:12px"><thead><tr><th style="text-align:left">Since the ${esc(c.from)} month-end</th><th>Change to ${esc(c.to)}</th></tr></thead><tbody>
        <tr><td style="text-align:left"><b>Finalist 2 (paper)</b></td><td style="color:${f2Col(c.finalist2)}"><b>${f2Pc(c.finalist2, 2)}</b></td></tr>
        <tr><td style="text-align:left">India mix (paper${c.indiaMixFrom ? `, from its ${esc(c.indiaMixFrom)} value` : ''})</td><td style="color:${f2Col(c.indiaMix)}">${f2Pc(c.indiaMix, 2)}</td></tr>
        <tr><td style="text-align:left">NIFTY 50 (index, no dividends)</td><td style="color:${f2Col(c.nifty)}">${f2Pc(c.nifty, 2)}</td></tr></tbody></table></div>`;
    }
    const cur = p.rebalances.at(-1);
    html += `<div class="note">Last rebalance ${esc(f2Day(cur.date))} (signal ${esc(cur.monthEnd)}): ${cur.k === 1 ? 'first month — both tranches filled' : `${cur.reranked.map((s) => F2_PART[s]).join(' and ')} re-ranked`}; parts ${cur.reset ? '<b>put back to target</b> (½ stocks · ⅓ gold · ⅙ Next 50)' : 'within 5 points of target, left as they were'}${cur.taxPaid ? ` · tax paid ${f2Amt(cur.taxPaid)}` : ''}.</div>`;
    if (p.marks?.length) {
      const order = { S1: 0, S2: 1, GOLD: 2, NN50: 3 };
      const rows = [...p.marks].sort((a, b) => (order[a.part] ?? 9) - (order[b.part] ?? 9) || a.name.localeCompare(b.name));
      html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Part</th><th style="text-align:left">Holding</th><th>Shares</th><th>Entry</th><th>Last</th><th>Value</th><th>Result</th></tr></thead><tbody>${rows.map((x) =>
        `<tr><td style="text-align:left">${esc(F2_PART[x.part] || x.part || '')}</td><td style="text-align:left">${x.kind === 'stock' ? `<span data-sym="${esc(x.symbol)}">${esc(x.name)}</span>` : esc(x.name)}</td><td>${Math.round(x.shares)}</td><td>${x.entry ? `₹${x.entry.toFixed(2)}` : '–'}</td><td>${x.last ? `₹${x.last.toFixed(2)}` : '–'}</td><td>${f2Amt(x.value)}</td><td style="color:${f2Col(x.retPct)}">${x.retPct == null ? '–' : `${x.retPct >= 0 ? '+' : ''}${x.retPct.toFixed(2)}%`}</td></tr>`).join('')}
        <tr><td style="text-align:left" colspan="5">Cash (earns ≈6.5% a year after tax in the test)</td><td>${f2Amt(p.cash)}</td><td></td></tr></tbody></table></div>
        <div class="note">Entry = the buy price (average of the day's open and close, real shares — not split-adjusted); a holding that was kept keeps its first entry.</div>`;
    }
  } else {
    html += `<div class="note">Paper portfolio (${f2Amt(d.rule?.capital || 100000)}) starts at the first month-end from Nov 2026${p?.startedAt ? ` (record opened ${esc(p.startedAt)})` : ''}: signal on the last NSE session of November (30 Nov 2026), buys on Tue 1 Dec 2026 at the average of the open and close.</div>`;
  }
  const n = d.next;
  if (n) html += `<div style="margin-top:8px;font-size:13px"><b>Next rebalance:</b> signal ${esc(f2Day(n.signal))} (close) → trade ${esc(f2Day(n.trade))} · ${esc(n.tranche)}.</div>`;
  html += `<div class="note">${esc(d.firstMonth || '')}</div>`;
  if (R) {
    html += `<div style="font-size:14px;margin-top:12px"><b>How it was tested</b> — ${esc(R.basis)}</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Period</th><th>Finalist 2</th><th>India mix</th><th>Worst fall F2</th><th>Worst fall India mix</th><th></th></tr></thead><tbody>${R.rows.map((x) =>
        `<tr><td style="text-align:left">${esc(x.period)} <span class="note" style="display:inline">(${esc(x.seen)})</span></td><td style="color:${x.lost ? 'var(--down)' : 'var(--up)'}"><b>${f2Pct(x.f2)}</b></td><td>${f2Pct(x.im)}</td><td style="color:var(--down)">${(x.f2dd * 100).toFixed(1)}%</td><td style="color:var(--down)">${(x.imdd * 100).toFixed(1)}%</td><td>${x.lost ? 'lost' : 'won'}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">Verdict: ${esc(R.verdict)}. Rule: last NSE session of each month, the 200 most-traded stocks (no ETFs, ≥ 260 sessions), score ¼·(6-month return ÷ vol) + ¼·(12-month return ÷ vol) + ½·(12-1 momentum beyond NIFTY) + ½·(months it beat NIFTY); two tranches of 4 that re-rank in alternate months and keep names still in the top 24; whole real shares; a name whose one share costs more than its slot is skipped; parts reset only past 5 points. Paper only — not in Today's algo plan. Not advice.</div>`;
  }
  $('f2Out').innerHTML = html;
  if (typeof avoidMark === 'function') avoidMark($('f2Out')); // ⚠ don't-buy-now badges (43-avoid-list.js)
}
lazy('Finalist 2', async () => {
  try { f2Render(await api('/api/finalist2')); } catch (e) { $('f2Out').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
