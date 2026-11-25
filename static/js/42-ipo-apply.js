// 42-ipo-apply.js — Trading strategies → IPO apply: paper record of applying for the minimum retail lot in every mainboard
// IPO on its last day and selling at the listing-day open (loop 19). Apply list, awaiting listing, settled, totals, research.
// Classic script (not a module): loaded in order by index.html.
const ipRs = (v) => `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v || 0)).toLocaleString('en-IN')}`;
const ipCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
const ipX = (x) => (x == null ? '–' : `${x.toFixed(x < 10 ? 2 : 1)}×`);
const ipToday = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

function ipoRender(st) {
  if (!st.startedAt) {
    $('ipoOut').innerHTML = '<div class="note">Starts with the next evening job (it reads NSE\'s IPO lists).</div>';
    return;
  }
  const today = ipToday();
  const t = st.totals || { expected: {}, lottery: {} };
  const apps = Object.values(st.applications || {});
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px"><b>Paper record since ${esc(st.startedAt)}</b>: ${t.applications || 0} application${t.applications === 1 ? '' : 's'} · ${t.settled || 0} settled · ${t.pending || 0} pending
    <div style="margin-top:4px">Expected value: <b style="color:${ipCol(t.expected.pnl)}">${ipRs(t.expected.pnl)}</b> before tax · ${ipRs(t.expected.afterTax)} after tax · <b style="color:${ipCol(t.expected.net)}">${ipRs(t.expected.net)}</b> after the opportunity cost (${ipRs(t.expected.oppCost)}) · about ${(t.expected.allotments || 0).toFixed(1)} allotments expected among the ${t.settled || 0} settled${t.pending ? ` (${t.pending} pending: counted once settled)` : ""}</div>
    <div>One lottery path (seeded draw per IPO): <b style="color:${ipCol(t.lottery.pnl)}">${ipRs(t.lottery.pnl)}</b> before tax · ${ipRs(t.lottery.net)} after tax and opportunity cost · ${t.lottery.allotments || 0} allotted</div>
    <div class="note" style="margin:4px 0 0">NSE lists checked ${st.updatedAt ? esc(st.updatedAt.slice(0, 10)) : '–'} each evening · SME issues skipped (${st.smeSkipped || 0} open now)${st.fetchError ? ` · <span style="color:var(--down)">last check failed (${esc(st.fetchError)})</span>` : ''}.</div></div>`;

  // apply list
  html += `<div style="font-size:14px;margin-top:10px"><b>Apply list</b> — open mainboard IPOs; the rule applies on the <b>last day</b> (UPI mandate by 5 PM)</div>`;
  const open = (st.openIssues || []).filter((x) => x.close >= today);
  html += open.length
    ? `<div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">IPO</th><th>Last day</th><th>Price band</th><th>Min lot</th><th>≈ Amount</th><th>Retail so far</th></tr></thead><tbody>${open.map((x) =>
      `<tr><td style="text-align:left"><b>${esc(x.symbol)}</b> <span class="note" style="display:inline">${esc((x.name || '').slice(0, 40))}</span></td><td>${x.close === today ? '<b style="color:var(--up)">today</b>' : esc(x.close)}</td><td>${x.band ? `₹${x.band.lo}–${x.band.hi}` : '–'}</td><td>${x.lot ?? '–'}</td><td>${x.amount ? ipRs(x.amount) : '–'}</td><td>${ipX(x.retailX)}${x.retailAsOf ? ` <span class="note" style="display:inline">${esc(x.retailAsOf)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="note">No mainboard IPO open right now (as of the last evening check).</div>';

  // awaiting listing
  const pending = apps.filter((a) => !['settled', 'no listing', 'no data'].includes(a.status)).sort((a, b) => a.closeDate.localeCompare(b.closeDate));
  if (pending.length) {
    html += `<div style="font-size:14px;margin-top:10px"><b>Applied, awaiting listing</b></div><div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">IPO</th><th>Applied (last day)</th><th>Lot × price</th><th>Blocked</th><th>Retail</th><th>Allotment chance</th><th>Listing</th><th style="text-align:left">Status</th></tr></thead><tbody>${pending.map((a) =>
      `<tr><td style="text-align:left"><b>${esc(a.symbol)}</b></td><td>${esc(a.appliedOn)}${a.late ? ' <span class="note" style="display:inline">(recorded late)</span>' : ''}</td><td>${a.lot ?? '–'} × ₹${a.issuePrice ?? '–'}</td><td>${a.lot && a.issuePrice ? ipRs(a.lot * a.issuePrice) : '–'}</td><td>${ipX(a.retailX)}${a.retailX != null && !a.final ? ' <span class="note" style="display:inline">not final</span>' : ''}</td><td>${a.retailX ? `${(Math.min(1, 1 / a.retailX) * 100).toFixed(0)}%` : '–'}</td><td>${a.listingDate ? esc(a.listingDate) : a.expectedListing ? `≈ ${esc(a.expectedListing)}` : '–'}</td><td style="text-align:left">${esc(a.status)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // settled
  const done = apps.filter((a) => a.status === 'settled').sort((a, b) => b.listingDate.localeCompare(a.listingDate));
  if (done.length) {
    html += `<details style="margin-top:8px" open><summary style="cursor:pointer;font-size:13px">Settled at the listing open (${done.length})</summary><div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">IPO</th><th>Listed</th><th>Issue → open</th><th>Lot</th><th>Retail</th><th>Chance</th><th>If allotted</th><th>Expected</th><th>Lottery</th><th>Opp. cost</th></tr></thead><tbody>${done.map((a) =>
      `<tr><td style="text-align:left">${esc(a.symbol)}</td><td>${esc(a.listingDate)}</td><td>₹${a.issuePrice} → ₹${a.open}</td><td>${a.lot}</td><td>${ipX(a.retailX)}</td><td>${(a.p * 100).toFixed(0)}%</td><td style="color:${ipCol(a.gainIfAllotted)}">${ipRs(a.gainIfAllotted)}</td><td style="color:${ipCol(a.expPnl)}"><b>${ipRs(a.expPnl)}</b></td><td>${a.allotted ? `<span style="color:${ipCol(a.lotteryPnl)}">allotted ${ipRs(a.lotteryPnl)}</span>` : '<span class="note" style="display:inline">not allotted</span>'}</td><td>${ipRs(-a.oppCost)}</td></tr>`).join('')}</tbody></table></div><div class="note">Sell costs: 0.15% of the sale + ₹20 DP charge. Opportunity cost: the blocked amount earns savings interest (2.7%) instead of an arbitrage fund (≈ 6.5%) from the close to the listing.</div></details>`;
  }
  const skipped = apps.filter((a) => ['no listing', 'no data'].includes(a.status));
  if (skipped.length) html += `<div class="note">Left out of the totals: ${skipped.map((a) => `${esc(a.symbol)} (${esc(a.note || a.status)})`).join(' · ')}</div>`;
  if (st.byFy?.length) {
    html += `<div style="overflow-x:auto;margin-top:6px"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Financial year</th><th>IPOs</th><th>Expected P&amp;L</th><th>Tax (20.8% on net gain)</th><th>Lottery P&amp;L</th><th>Lottery tax</th></tr></thead><tbody>${st.byFy.map((f) =>
      `<tr><td style="text-align:left">${esc(f.fy)}</td><td>${f.n}</td><td style="color:${ipCol(f.expPnl)}">${ipRs(f.expPnl)}</td><td>${ipRs(f.expTax)}</td><td style="color:${ipCol(f.lotteryPnl)}">${ipRs(f.lotteryPnl)}</td><td>${ipRs(f.lotteryTax)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // research
  const R = st.research;
  if (R) {
    html += `<div style="font-size:14px;margin-top:12px"><b>How it was tested</b> (NSE IPOs, minimum retail lot every mainboard IPO, sold at the listing open, after tax, vs leaving the money in an arbitrage fund)</div>
      <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Period</th><th>Gain a year after tax, vs arbitrage fund</th><th style="text-align:left"></th></tr></thead><tbody>${R.rows.map((x) =>
        `<tr><td style="text-align:left">${esc(x.period)}</td><td><b>+${ipRs(x.perYear)}</b></td><td style="text-align:left" class="note">${esc(x.note)}</td></tr>`).join('')}</tbody></table></div>
      <div style="margin-top:6px;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:12px;border-left:3px solid var(--warn)"><b>Cautions</b><ul style="margin:4px 0 0 18px;padding:0">${R.cautions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
  }
  html += '<div class="note" style="margin-top:6px">Paper / research only — a small add-on of a few thousand rupees a year per PAN, not a strategy for your capital. Not advice.</div>';
  $('ipoOut').innerHTML = html;
}
lazy('IPO apply', async () => {
  try { ipoRender(await api('/api/ipo-apply')); } catch (e) { $('ipoOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
