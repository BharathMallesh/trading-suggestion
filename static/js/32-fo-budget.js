// 32-fo-budget.js — Options & risk → Fits my budget: options a small account can buy, with chance of profit.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const FB_KEY = 'fo-budget';
try {
  const saved = JSON.parse(localStorage.getItem(FB_KEY) || 'null');
  if (saved?.capital) {
    $('fbCap').value = saved.capital;
    $('fbPer').value = saved.perTrade;
    $('frAcct').value = saved.capital;
  }
} catch {
  /* storage blocked: defaults stay */
}
async function fbLoad() {
  try {
    localStorage.setItem(FB_KEY, JSON.stringify({ capital: Number($('fbCap').value), perTrade: Number($('fbPer').value) }));
  } catch {
    /* storage blocked */
  }
  $('frAcct').value = $('fbCap').value;
  $('fbBtn').disabled = true;
  $('fbOut').innerHTML = '<div class="note">Checking every Strong / Weak F&O stock and NIFTY (about 20 seconds the first time)…</div>';
  try {
    const r = await api(`/api/fo-affordable?capital=${encodeURIComponent($('fbCap').value || 10000)}&perTrade=${encodeURIComponent($('fbPer').value || 3000)}`);
    const lean = { strong: '🟢 strong', weak: '🔴 weak', index: 'index' };
    $('fbOut').innerHTML = r.rows.length
      ? `<div style="font-size:13px"><b>${r.rows.length} option${r.rows.length === 1 ? '' : 's'} fit ₹${r.perTrade.toLocaleString('en-IN')} a trade</b> — about ${r.tries} tries with ₹${r.capital.toLocaleString('en-IN')} (prices of ${esc(r.date || '–')})</div>
        <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Lean</th><th>Trade</th><th>Price × lot</th><th>Most you can lose<br><span class="note" style="display:inline">(cost + charges)</span></th><th>Charges</th><th>Chance of profit</th><th>Average result*</th><th>Expiry</th><th></th></tr></thead><tbody>${r.rows.map((x) =>
          `<tr><td style="text-align:left"><b>${esc(x.symbol)}</b> <span class="note" style="display:inline">₹${x.spot.toFixed(1)}</span></td><td>${lean[x.lean] || ''}</td><td>${x.kind === 'spread' ? `<b>spread</b>: buy ${x.legs[0].strike} / sell ${x.legs[1].strike} ${x.type === 'CE' ? 'call' : 'put'} <span class="note" style="display:inline">(max profit ₹${Math.round(x.maxProfit).toLocaleString('en-IN')})</span>` : `buy ${x.strike} ${x.type === 'CE' ? 'call' : 'put'} <span class="note" style="display:inline">(${x.distancePct ? `${x.distancePct}% out` : 'at the money'})</span>`}</td><td>${x.kind === 'spread' ? `${(x.legs[0].price - x.legs[1].price).toFixed(2)} net` : x.price.toFixed(2)} × ${x.lot}</td><td style="color:var(--down)"><b>₹${Math.round(x.maxLoss ?? x.cost).toLocaleString('en-IN')}</b></td><td>${x.charges != null ? `₹${Math.round(x.charges).toLocaleString('en-IN')} <span class="note" style="display:inline">(${Math.round((x.charges / x.cost) * 100)}% of cost${x.minVolume < 100 ? ', thinly traded' : ''})</span>` : '–'}</td><td><b>${Math.round(x.chanceOfProfit * 100)}%</b></td><td style="color:${x.average >= 0 ? 'var(--up)' : 'var(--down)'}">${x.average >= 0 ? '+' : '−'}₹${Math.abs(Math.round(x.average)).toLocaleString('en-IN')}${x.historyYears < 5 ? ` <span class="note" style="display:inline">(${x.historyYears.toFixed(1)} yrs data)</span>` : ''}</td><td>${esc(x.expiry)} <span class="note" style="display:inline">(${x.sessions} sessions)</span></td>
            <td><a href="#" data-fb="${esc(x.symbol)}" data-side="${x.strategy}" data-dist="${x.distancePct}" data-wing="${x.wing ?? ''}" data-wingpct="${x.wingPct ?? ''}">Risk check</a></td></tr>`).join('')}</tbody></table></div>
        <div class="note">These fit a per-trade limit of ₹${r.perTrade.toLocaleString('en-IN')} (${Math.round((r.perTrade / r.capital) * 100)}% of ₹${r.capital.toLocaleString('en-IN')}). At the usual 2% rule (₹${Math.round(r.capital * 0.02).toLocaleString('en-IN')}) nothing in F&O fits this account — one lot of even the cheapest spread can lose more. "Thinly traded" = a leg traded under 100 contracts that day: real prices may be worse.</div>
        <div class="note">* The average over every past move is lifted by rare big moves that paid many times the cost; most cases lose the whole cost. ${esc(r.note)}</div>`
      : `<div class="note">Nothing can lose at most ₹${Number($('fbPer').value).toLocaleString('en-IN')} (cost + charges) for one lot today. Lot sizes make even cheap options cost ₹1,000–3,000+ a lot. ${esc(r.note)}</div>`;
    for (const a of document.querySelectorAll('#fbOut [data-fb]')) a.addEventListener('click', (e) => {
      e.preventDefault();
      $('frSym').value = a.dataset.fb;
      $('frStrat').value = a.dataset.side;
      $('frDist').value = a.dataset.dist || 0;
      if (a.dataset.wing) $('frWing').value = a.dataset.wing;
      if (a.dataset.wingpct) $('frWingPct').value = a.dataset.wingpct;
      $('frAcct').value = $('fbCap').value;
      // judge it against the per-trade limit set here (e.g. ₹3,000 of ₹10,000 = 30%), not the 2% default
      $('frMax').value = Math.min(50, Math.max(0.5, Math.ceil((Number($('fbPer').value) / Number($('fbCap').value)) * 100)));
      $('foRiskCard').scrollIntoView();
      frLoad();
    });
  } catch (e) {
    $('fbOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('fbBtn').disabled = false;
  }
}
$('fbBtn').addEventListener('click', fbLoad);
