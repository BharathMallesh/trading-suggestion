// 26-option-strikes.js — Options & risk → Option strike guide: ITM vs ATM vs OTM on real NSE weekly prices.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const osPc = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);
const osCol = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');
let osData = null;

function osPick() {
  const r = osData;
  const b = r.hindsight[Number($('strikeMove').value)];
  const kinds = ['ITM', 'ATM', 'OTM'];
  const best = kinds.reduce((a, k) => ((b[k].avg ?? -9) > (b[a].avg ?? -9) ? k : a), 'ITM');
  return `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:13px">If NIFTY moves <b>${esc(b.label)}</b> your way by expiry (${Math.round(b.share * 100)}% of weeks), the strike that did best was <b>${best}</b>:
    <table style="font-size:12px;margin-top:6px"><thead><tr><th style="text-align:left">Strike</th><th>Average</th><th>Weeks won</th><th>If the direction was wrong</th></tr></thead><tbody>${kinds.map((k) =>
      `<tr><td style="text-align:left">${k === best ? '<b>' : ''}${k}${k === best ? '</b>' : ''} <span class="note" style="display:inline">(median premium ${Math.round(r.premiums[k].call)} / ${Math.round(r.premiums[k].put)} pts call / put)</span></td><td style="color:${osCol(b[k].avg)}"><b>${osPc(b[k].avg)}</b></td><td>${b[k].win == null ? '–' : `${Math.round(b[k].win * 100)}%`}</td><td style="color:var(--down)">${osPc(r.wrong[k].avg)}</td></tr>`).join('')}</tbody></table>
    <div class="note">% of the premium paid, after charges. This assumes your direction is right — the right-hand column is what happened when it was wrong.</div></div>`;
}

function osRender() {
  const r = osData;
  const kinds = ['ITM', 'ATM', 'OTM'];
  let html = `<div id="strikePick">${osPick()}</div>`;
  html += `<div style="margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid ${r.passed ? 'var(--up)' : 'var(--warn)'};font-size:13px"><b>${esc(r.verdict)}</b></div>`;
  html += `<div style="font-size:14px;margin-top:12px"><b>As in the video — direction known in hindsight</b> (by NIFTY's move in your favour; average % of premium / weeks won)</div>
    <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Move your way</th><th>Weeks</th>${kinds.map((k) => `<th>${k}</th>`).join('')}</tr></thead><tbody>${r.hindsight.map((b) =>
      `<tr><td style="text-align:left">${esc(b.label)}</td><td>${b.weeks} (${Math.round(b.share * 100)}%)</td>${kinds.map((k) => `<td style="color:${osCol(b[k].avg)}">${osPc(b[k].avg)} <span class="note" style="display:inline">${b[k].win == null ? '' : `${Math.round(b[k].win * 100)}%`}</span></td>`).join('')}</tr>`).join('')}
      <tr><td style="text-align:left">Wrong direction</td><td>–</td>${kinds.map((k) => `<td style="color:var(--down)">${osPc(r.wrong[k].avg)}</td>`).join('')}</tr></tbody></table></div>`;
  html += `<div style="font-size:14px;margin-top:12px"><b>As a trader really faces it — direction not known in advance</b></div>
    <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">How the side was chosen</th>${kinds.map((k) => `<th>${k}: average · won · ₹ a year (1 lot a week)</th>`).join('')}</tr></thead><tbody>${Object.values(r.real).map((g) =>
      `<tr><td style="text-align:left">${esc(g.label)}</td>${kinds.map((k) => `<td><span style="color:${osCol(g[k].avg)}">${osPc(g[k].avg)}</span> · ${Math.round(g[k].win * 100)}% · <b style="color:${osCol(g[k].rupeesPerYearLot)}">${g[k].rupeesPerYearLot < 0 ? '−' : '+'}₹${Math.abs(Math.round(g[k].rupeesPerYearLot)).toLocaleString('en-IN')}</b><div class="note" style="margin:0">2019–22 ${osPc(g[k].early)} · 2023→ ${osPc(g[k].later)}</div></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  html += `<div class="note" style="margin-top:6px">${r.weeks} weekly cycles, ${esc(r.from)} → ${esc(r.to)}. ${esc(r.note)}</div>`;
  $('strikeOut').innerHTML = html;
}
lazy('Option strike guide', async () => {
  try {
    osData = await api('/api/option-strikes');
    if (!osData.hindsight) {
      $('strikeOut').innerHTML = '<div class="note">Not run yet (it runs with the Saturday re-tests).</div>';
      return;
    }
    $('strikeMove').innerHTML = osData.hindsight.map((b, i) => `<option value="${i}"${i === 2 ? ' selected' : ''}>${esc(b.label)}</option>`).join('');
    osRender();
  } catch (e) {
    $('strikeOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
$('strikeMove').addEventListener('change', () => {
  if (osData?.hindsight) $('strikePick').innerHTML = osPick();
});
