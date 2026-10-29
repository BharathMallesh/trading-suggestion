// 19-my-plan.js — Home → My plan: what the tested rules say to do now, in one place.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const mpAmt = (v) => `₹${Math.round(v || 0).toLocaleString('en-IN')}`;
const mpDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const mpBox = (title, body, color = 'var(--line)') => `<div style="padding:10px 12px;border-radius:10px;border:1px solid ${color};margin-top:8px"><div style="font-size:14px"><b>${title}</b></div>${body}</div>`;

function mpRender(r) {
  let html = '';
  // regime
  if (r.regime) html += `<div style="padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px"><b>Market regime: ${r.regime.state === 'out' ? '<span style="color:var(--down)">OUT</span> — NIFTY is below its long-term trend (a cautious time for new stock positions)' : r.regime.state === 'in' ? '<span style="color:var(--up)">IN</span> — NIFTY is above its long-term trend' : 'unchanged'}</b><div class="note" style="margin:2px 0 0">${esc(r.regime.reading || '')}</div></div>`;

  // 1. core
  html += mpBox(`1. Core (about 80%, ${mpAmt(r.capital * 0.8)} of ${mpAmt(r.capital)}): a NIFTY 50 index fund`,
    `${r.core.funds.length ? `<div style="font-size:13px;margin-top:4px">Lowest-cost examples (what investors kept over 3 years): ${r.core.funds.map((f) => `<b>${esc(f.name)}</b> (${esc(f.type)}, ${(f.r3 * 100).toFixed(1)}% a year)`).join(' · ')}</div>` : ''}<div class="note" style="margin:4px 0 0">${esc(r.core.note)}</div>`);

  // 2. momentum
  const m = r.momentum;
  if (m) {
    html += mpBox(`2. Satellite: Momentum 20 list ${m.passed ? '<span style="color:var(--up);font-size:12px">passed its test</span>' : ''}`,
      `<div style="font-size:13px;margin-top:4px">Ranked at the ${esc(m.rankedAt)} close: ${m.list.map((x) => `<b>${esc(x.symbol)}</b>`).join(', ')}.</div>
      <div style="font-size:13px;margin-top:4px">Equal amounts: <b>${mpAmt(m.perStockSatellite)} a stock</b> if it is your 20% satellite (${mpAmt(r.capital * 0.2)} in all), or ${mpAmt(m.perStock)} a stock with all ${mpAmt(r.capital)}.</div>
      <div style="font-size:13px;margin-top:4px">Next change: the list is re-made from the <b>${esc(mpDate(m.monthEnd))}</b> close and swapped at the <b>${esc(mpDate(m.nextRebalance))}</b> open${m.likelyIn.length || m.likelyOut.length ? ` — on the ${esc(m.previewAt || '')} prices, likely in: <b>${esc(m.likelyIn.join(', ') || 'none')}</b> · likely out: <b>${esc(m.likelyOut.join(', ') || 'none')}</b>` : ''}.</div>
      <div class="note" style="margin:4px 0 0">${m.paperStarted ? 'Tracked as a paper portfolio (Investing → Momentum 20).' : 'The paper portfolio starts with the next list.'} Realistic test: about 13–15% a year after tax vs 9.7% for NIFTY, with bad years (e.g. −13% in 2025) and falls of about 30–38%.</div>`, 'var(--up)');
  }

  // 3. swing
  const s = r.swing;
  const sig = s.signals.length
    ? `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Breakout today</th><th>Setup</th><th>Close</th><th>Stop</th><th>Risk</th><th>Shares at 1% risk</th></tr></thead><tbody>${s.signals.map((x) => `<tr><td style="text-align:left"><b>${esc(x.symbol)}</b></td><td>${esc(x.setup)}</td><td>₹${x.close.toFixed(1)}</td><td>₹${x.stop.toFixed(1)}</td><td>${x.riskPct.toFixed(1)}%</td><td>${x.shares ?? '–'}${x.value ? ` (${mpAmt(x.value)})` : ''}</td></tr>`).join('')}</tbody></table></div><div class="note">The rules buy at the next open with that stop.</div>`
    : '<div style="font-size:13px;margin-top:4px">No breakout at the latest close — nothing new to buy.</div>';
  const open = s.open.length
    ? `<div style="overflow-x:auto;margin-top:6px"><table style="font-size:12px"><thead><tr><th style="text-align:left">Holding (paper)</th><th>Bought</th><th>Last close</th><th>Trailing stop</th><th>Room to stop</th><th>Result so far</th></tr></thead><tbody>${s.open.map((x) => `<tr><td style="text-align:left">${esc(x.symbol)}</td><td>${esc(x.entryDate)} at ₹${x.entry.toFixed(1)}</td><td>₹${x.last.toFixed(1)}</td><td>₹${x.stop.toFixed(1)}</td><td style="color:${x.gapToStopPct < 2 ? 'var(--down)' : 'var(--ink)'}">${x.gapToStopPct == null ? '–' : `${x.gapToStopPct.toFixed(1)}%`}</td><td style="color:${x.r >= 0 ? 'var(--up)' : 'var(--down)'}">${x.r >= 0 ? '+' : ''}${x.r.toFixed(2)}R</td></tr>`).join('')}</tbody></table></div><div class="note">A close below the trailing stop means sell at the next open. Red = within 2% of the stop.</div>`
    : '';
  html += mpBox(`3. Satellite: strong-stock swing (${esc(s.version)} rules)`, sig + open);

  // 4. skip
  html += mpBox('4. Skip (still tracked on paper, not for real money)',
    `<ul style="margin:4px 0 0 18px;padding:0;font-size:13px;line-height:1.6">${r.skip.map((x) => `<li><b>${esc(x.name)}</b>: ${x.trades} paper trade${x.trades === 1 ? '' : 's'}, <span style="color:${x.net >= 0 ? 'var(--up)' : 'var(--down)'}">${x.net >= 0 ? '+' : '−'}${mpAmt(Math.abs(x.net))}</span> — ${esc(x.why)}</li>`).join('')}</ul>`, 'var(--warn)');

  // 5. dates
  html += mpBox('5. Next dates', `<ul style="margin:4px 0 0 18px;padding:0;font-size:13px;line-height:1.6">${r.dates.map((d) => `<li><b>${esc(mpDate(d.date))}</b>: ${esc(d.what)}</li>`).join('')}</ul>`);
  if (r.careful?.length) html += `<div class="note" style="margin-top:6px;color:var(--warn)">Unusually likely to swing 4%+ this week: ${esc(r.careful.join(', '))}.</div>`;
  html += `<div class="note" style="margin-top:8px">${esc(r.note)} Updated ${esc(new Date(r.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}.</div>`;
  $('planNowOut').innerHTML = html;
}
async function mpLoad(fresh = false) {
  $('planNowBtn').disabled = true;
  if (fresh) $('planNowOut').innerHTML = '<div class="note">Checking the market and the paper records (about 10 seconds)…</div>';
  try { mpRender(await api('/api/my-plan' + (fresh ? '?fresh=1' : ''))); } catch (e) { $('planNowOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; } finally { $('planNowBtn').disabled = false; }
}
lazy('My plan', () => mpLoad(false));
$('planNowBtn').addEventListener('click', () => mpLoad(true));
