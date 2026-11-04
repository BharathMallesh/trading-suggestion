// 33-spread-paper.js — Options & risk → Spread paper tracker: the ₹10,000 practice account.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
function spRender(st) {
  if (!st.trades) {
    $('spOut').innerHTML = '<div class="note">Starts with the next evening job.</div>';
    return;
  }
  const s = st.summary;
  const rs = (v) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
  const col = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px"><b>Account ₹${Math.round(s.value).toLocaleString('en-IN')}</b> <span style="color:${col(s.value - st.rules.capital)}">(${rs(s.value - st.rules.capital)})</span> from ₹${st.rules.capital.toLocaleString('en-IN')} on ${esc(st.startedAt)}
    · cash ₹${Math.round(st.cash).toLocaleString('en-IN')} · ${s.open} open · ${s.closed} closed${s.closed ? `, won ${s.won} (${Math.round(s.winRate * 100)}%), ${rs(s.realised)} realised` : ''}</div>`;
  if (st.trades.length) html += `<div style="overflow-x:auto"><table style="font-size:12px;margin-top:6px"><thead><tr><th style="text-align:left">Stock</th><th>Lean</th><th>Spread</th><th>Bought</th><th>Expiry</th><th>Cost <span class="note" style="display:inline">+ charges</span></th><th>Max profit</th><th>Chance at entry</th><th>Now / result</th></tr></thead><tbody>${[...st.trades].reverse().map((t) =>
    `<tr><td style="text-align:left"><b>${esc(t.symbol)}</b></td><td>${t.lean === 'strong' ? '🟢' : t.lean === 'weak' ? '🔴' : 'index'}</td><td>${t.legs.map((l) => `${l.q > 0 ? 'buy' : 'sell'} ${l.k} ${l.t === 'CE' ? 'call' : 'put'}`).join(' / ')}</td><td>${esc(t.entryDate)}</td><td>${esc(t.expiry)}${t.exitBy && t.open ? ` <span class="note" style="display:inline">(sell by ${esc(t.exitBy)})</span>` : ''}</td><td>₹${Math.round(t.cost).toLocaleString('en-IN')}${t.entryCharges != null ? ` <span class="note" style="display:inline">+ ₹${Math.round(t.entryCharges).toLocaleString('en-IN')}</span>` : ''}</td><td>₹${Math.round(t.maxProfit).toLocaleString('en-IN')}</td><td>${Math.round(t.chanceOfProfit * 100)}%</td>
      <td style="color:${col(t.open ? t.mark : t.pnl)}"><b>${t.open ? (t.unsettled ? 'waiting for the expiry price' : t.mark != null ? `${rs(t.mark)} <span class="note" style="display:inline">(${esc(t.markDate)})</span>` : 'open') : `${rs(t.pnl)} <span class="note" style="display:inline">(${t.settleHow === 'sold before expiry' ? `sold ${esc(t.settleDate)}` : `settled ${t.settlePrice?.toFixed(1) ?? ''}`})</span>`}</b></td></tr>`).join('')}</tbody></table></div>`;
  html += '<div class="note">Paper only. Trades open at the closing prices of the day NSE\'s file is for (never older prices). "Now" = what the spread would fetch at the latest NSE option closes, after the charges already paid and the charges to close. Stock options settle by delivery, so stock spreads are sold 2 sessions before expiry; NIFTY spreads are held to expiry. Judge it only after 20–30 closed trades.</div>';
  $('spOut').innerHTML = html;
}
lazy('Spread paper tracker', async () => {
  try { spRender(await api('/api/spread-paper')); } catch (e) { $('spOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
