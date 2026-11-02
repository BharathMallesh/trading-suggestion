// 29-trade-plan.js — Home → Swing trade plan: tomorrow's buys, sells and stops (Strong-stock swing, wide trail).
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const tpRs = (v) => `₹${Math.round(v || 0).toLocaleString('en-IN')}`;
const tpP = (v) => `₹${(v || 0).toFixed(1)}`;
const tpCol = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');

function tpRender(p) {
  const c = p.counts;
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid ${c.buy || c.sell ? 'var(--up)' : 'var(--line)'};font-size:14px">
    <b>For the next open${p.asOf ? ` (after the ${esc(p.asOf)} close)` : ''}: buy ${c.buy} · sell ${c.sell} · hold ${c.hold}</b> <span class="note" style="display:inline">${c.freeSlots} of ${p.rules.maxOpen} slots free</span>
    <ol style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.6">${p.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>`;
  const buys = p.buy.filter((b) => b.action === 'buy');
  html += `<div style="font-size:14px;margin-top:12px"><b>BUY at the open</b></div>`;
  html += buys.length
    ? `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Setup</th><th>Close</th><th>Stop</th><th>Shares</th><th>Value</th><th>At risk</th></tr></thead><tbody>${buys.map((b) => `<tr><td style="text-align:left"><b>${esc(b.symbol)}</b></td><td>${esc(b.setup)}</td><td>${tpP(b.close)}</td><td>${tpP(b.stop)}</td><td><b>${b.shares}</b></td><td>${tpRs(b.value)}</td><td style="color:var(--down)">${tpRs(b.riskRs)} (${b.riskPct.toFixed(1)}%)</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="note">No new breakout at the latest close — nothing to buy.</div>';
  const skipped = p.buy.filter((b) => b.action === 'skip');
  if (skipped.length) html += `<div class="note">Not bought: ${skipped.map((b) => `${esc(b.symbol)} (${esc(b.why)})`).join(' · ')}</div>`;
  const sells = p.hold.filter((h) => h.action === 'sell');
  if (sells.length) html += `<div style="font-size:14px;margin-top:12px;color:var(--down)"><b>SELL at the open</b> (closed below the trailing stop): ${sells.map((h) => `<b>${esc(h.symbol)}</b> ${h.shares} shares (stop ${tpP(h.stop)}, last ${tpP(h.last)})`).join(' · ')}</div>`;
  const holds = p.hold.filter((h) => h.action === 'hold');
  html += `<div style="font-size:14px;margin-top:12px"><b>HOLD — set these stops</b></div>`;
  html += holds.length
    ? `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Entry</th><th>Last</th><th>Stop for tomorrow</th><th>Room to stop</th><th>Shares</th><th>Result</th></tr></thead><tbody>${holds.map((h) => `<tr><td style="text-align:left"><b>${esc(h.symbol)}</b></td><td>${esc(h.entryDate)}</td><td>${tpP(h.entry)}</td><td>${tpP(h.last)}</td><td><b>${tpP(h.stop)}</b>${h.stopRaised ? ' <span class="note" style="display:inline">raised</span>' : ''}</td><td style="color:${h.gapToStopPct < 2 ? 'var(--down)' : 'var(--ink)'}">${h.gapToStopPct?.toFixed(1) ?? '–'}%</td><td>${h.shares}</td><td style="color:${tpCol(h.pnl)}"><b>${h.pnl >= 0 ? '+' : '−'}${tpRs(Math.abs(h.pnl))}</b> (${h.r >= 0 ? '+' : ''}${h.r.toFixed(2)} R)</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="note">No open positions.</div>';
  if (p.sold.length) html += `<div class="note">Sold today: ${p.sold.map((s) => `${esc(s.symbol)} ${s.r >= 0 ? '+' : ''}${s.r.toFixed(2)} R (${esc(s.reason)})`).join(' · ')}</div>`;
  const rec = p.record;
  html += `<div class="note" style="margin-top:8px">Paper record (wide trail) since ${esc(rec.since || '–')}: ${rec.trades ? `${rec.trades} closed · won ${Math.round(rec.winRate * 100)}% · ${rec.avgR.toFixed(2)} R a trade` : 'no closed trades yet'} · ${rec.open} open. ${esc(p.note)}</div>`;
  $('tpOut').innerHTML = html + '<div id="tpOrb"></div>';
  tpOrb();
}
/** The entry timing test: buy at the open vs on the 10-minute opening-range breakout (same stock, stop and exit). */
async function tpOrb() {
  try {
    const o = await api('/api/swing-orb');
    const s = o.summary;
    if (!s) return;
    const f = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(2)} R`);
    const rows = Object.values(o.trades).sort((a, b) => b.entryDate.localeCompare(a.entryDate)).slice(0, 12);
    $('tpOrb').innerHTML = `<div style="margin-top:12px;padding:10px 12px;border-radius:10px;border:1px dashed var(--line);font-size:13px"><b>Entry timing test</b> (paper): buy at the 9:15 open vs only on a break above the 10-minute opening range (skip if the range breaks down first). Same stock, stop and exit.
      <div style="margin-top:4px">${s.closed} closed of ${s.trades}: at the open <b>${f(s.atOpen.avgR)}</b> a trade · opening-range entry <b>${f(s.orb.avgR)}</b> (taken ${s.orb.taken}, skipped ${s.orb.skipped}; the skipped ones made ${f(s.skippedAtOpenR)} at the open)</div>
      <div class="note" style="margin:4px 0 0">Too early to judge until about 50 closed trades (a few months). ${rows.map((t) => `${esc(t.symbol)} ${esc(t.entryDate)}: ${t.orb.skip ? `skipped (${esc(t.orb.skip)})` : `in at ${esc(t.orb.time)}`}${t.open ? ' · open' : ` · ${f(t.rOpen)} vs ${t.orb.skip ? '0' : f(t.rOrb)}`}`).join(' · ')}</div></div>`;
  } catch {
    /* the test file may not exist yet */
  }
}
async function tpLoad() {
  $('tpBtn').disabled = true;
  try { tpRender(await api(`/api/trade-plan?capital=${encodeURIComponent($('tpCap').value || 500000)}`)); } catch (e) { $('tpOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; } finally { $('tpBtn').disabled = false; }
}
lazy('Swing trade plan', tpLoad);
$('tpBtn').addEventListener('click', tpLoad);
