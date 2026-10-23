// 14-fo-strangle.js — Trading strategies → NIFTY short strangle (F&O, paper only).
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const foRs = (v) => (v == null ? '–' : (v < 0 ? '−₹' : '+₹') + Math.abs(Math.round(v)).toLocaleString('en-IN'));
const foPc = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const foAmt = (v) => `₹${Math.round(v || 0).toLocaleString('en-IN')}`;
const foCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');

function foRender(d) {
  const p = d.paper;
  const o = p?.status?.open;
  $('foStatus').innerHTML = p ? `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);border-left:4px solid ${o ? 'var(--accent)' : 'var(--muted)'}">
    <div style="font-size:14px"><b>${esc(p.status?.message || '')}</b></div>
    ${o ? `<div class="kv" style="margin-top:6px">
      <div>Sold</div><div>${o.callStrike} call + ${o.putStrike} put, expiry ${esc(o.expiry)} · NIFTY was ${Math.round(o.spot)}</div>
      <div>Premium received</div><div>${o.credit.toFixed(1)} points = ${foRs(o.credit * o.lot)} a lot (${o.lot} units)</div>
      <div>Value now</div><div style="color:${foCol(o.rupees)}"><b>${foRs(o.rupees)}</b> a lot after costs${o.markDate ? ` (prices of ${esc(o.markDate)})` : ''}</div>
      <div>Safe zone</div><div>NIFTY between ${o.putStrike} and ${o.callStrike} at expiry keeps the whole premium</div>
      <div>Margin blocked</div><div>≈ ${foAmt(o.margin * o.lot)}</div>
    </div>` : ''}
    <div class="note">NSE publishes option prices in the evening, so the record runs one session behind (latest prices: ${esc(p.lastDataDate || 'none yet')}). Paper since ${esc(p.startedAt)}.</div></div>` : '<div class="note">Paper record not started yet (it starts with the evening run).</div>';

  const b = d.backtest;
  let html = '';
  if (b) {
    const row = (n, x) => !x?.trades ? '' : `<tr><td style="text-align:left">${esc(n)}</td><td>${x.trades}</td><td><b>${Math.round(x.winRate * 100)}%</b></td><td style="color:${foCol(x.avgRsNowLot)}"><b>${foRs(x.avgRsNowLot)}</b></td><td>${x.tStat?.toFixed(2) ?? '–'}</td><td style="color:var(--down)">${x.worst.retOnMarginPct.toFixed(0)}% (${esc(x.worst.date)})</td><td>${foPc(x.accountCagr)}</td><td>${foPc(x.accountMaxDrawdown, 0)}</td></tr>`;
    html += `<div style="font-size:14px"><b>Backtest on real NSE option prices, ${esc(b.from)} → ${esc(b.to)}</b> · 1 lot a week, after all charges</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Period</th><th>Weeks</th><th>Won</th><th>Avg a week (lot of 65)</th><th>t</th><th>Worst week (% of margin)</th><th>Account per year</th><th>Worst fall</th></tr></thead><tbody>
        ${row('2019–2022', b.early)}${row('2023 onward (judged once)', b.later)}${row('All weeks', b.all)}</tbody></table></div>
      <div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px"><b>Verdict:</b> it won ${Math.round(b.all.winRate * 100)}% of weeks, but over the whole period the account made <b>${foPc(b.all.accountCagr)}</b> a year with a worst fall of <b>${foPc(b.all.accountMaxDrawdown, 0)}</b>,
        against <b>${foPc(b.niftyCagr)}</b> a year for simply holding NIFTY. The calm 2023+ years look good; 2019–2022 (t ${b.early.tStat?.toFixed(1)}) was no better than chance.
        Selling options wins small amounts often and loses big amounts rarely — one lot needs about <b>${foAmt(3 * (b.marginNow || 0))}</b> in the account (≈ ${foAmt(b.marginNow)} margin plus a buffer). Not a recommendation to trade.</div>`;
    if (b.worstWeeks?.length) html += `<div style="font-size:13px;margin-top:6px"><b>The worst weeks</b> (what one crash week does)</div><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Week of</th><th>NIFTY moved</th><th>Side hit</th><th>Loss (% of margin)</th><th>Loss a lot then</th><th>Same loss at today's size</th></tr></thead><tbody>${b.worstWeeks.map((w) =>
      `<tr><td style="text-align:left">${esc(w.entryDate)}</td><td>${w.move >= 0 ? '+' : ''}${(w.move * 100).toFixed(1)}%</td><td>${esc(w.breached || '–')}</td><td style="color:var(--down)"><b>${w.retOnMarginPct.toFixed(0)}%</b></td><td>${foRs(w.rsNowLot)}</td><td style="color:var(--down)">${foRs(w.rsAtTodaysSize)}</td></tr>`).join('')}</tbody></table></div>`;
    html += `<div class="note">${esc(b.note)}</div>`;
  } else html += '<div class="note">Backtest not run yet: press Re-run backtest.</div>';
  if (p?.trades?.length) {
    html += `<div style="font-size:14px;margin-top:10px"><b>Paper record</b>: ${p.summary.trades ? `${p.summary.trades} weeks closed · won ${Math.round(p.summary.winRate * 100)}% · total ${foRs(p.summary.totalRs)}` : 'no closed weeks yet'}</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Opened</th><th>Expiry</th><th>Put / call sold</th><th>Premium (pts)</th><th>NIFTY at expiry</th><th>Status</th><th>Result a lot</th></tr></thead><tbody>${p.trades.map((t) =>
      `<tr><td style="text-align:left">${esc(t.entryDate)}</td><td>${esc(t.expiry)}</td><td>${t.putStrike} / ${t.callStrike}</td><td>${t.credit.toFixed(1)}</td><td>${t.settle ? Math.round(t.settle) : '–'}</td><td>${t.open ? 'Open' : t.breached ? `Settled (${esc(t.breached)} side hit)` : 'Settled, both expired'}</td><td style="color:${foCol(t.rupees)}"><b>${foRs(t.rupees)}</b></td></tr>`).join('')}</tbody></table></div>`;
  }
  $('foOut').innerHTML = html;
}
lazy('NIFTY short strangle', async () => {
  try { foRender(await api('/api/fo-strangle')); } catch (e) { $('foOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
$('foRunBtn').addEventListener('click', async () => {
  $('foRunBtn').disabled = true;
  $('foOut').innerHTML = '<div class="note">Re-running on the cached NSE option weeks…</div>';
  try {
    const r = await api('/api/fo-strangle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    foRender({ ...(await api('/api/fo-strangle')), backtest: r.backtest });
  } catch (e) { $('foOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; } finally { $('foRunBtn').disabled = false; }
});
