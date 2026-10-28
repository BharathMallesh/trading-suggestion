// 17-day-patterns.js — Day patterns tab: every strategy by weekday and opening gap, plus the Monday tests.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const DP_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const dpVal = (s, unit) => {
  if (!s?.n) return '–';
  const v = s.avg;
  if (unit === '₹') return `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
  if (unit === 'R') return `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
};
const dpCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
const dpPc = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
function dpCell(s, unit, mark) {
  if (!s?.n) return '<td>–</td>';
  // a t score from a handful of trades means nothing: show it from 10 trades on
  const strong = s.n >= 10 && s.t != null && Math.abs(s.t) >= 2;
  return `<td style="color:${dpCol(s.avg)};${mark ? 'background:var(--soft);' : ''}">${strong ? '<b>' : ''}${dpVal(s, unit)}${strong ? '</b>' : ''}<div class="note" style="display:block;margin:0">${s.n} · ${Math.round(s.win * 100)}% won${s.n >= 10 && s.t != null ? ` · t ${s.t.toFixed(1)}` : ' · few trades'}</div></td>`;
}
function dpVerdict(s) {
  const v = s.verdict || {};
  if (v.note) return v.note;
  if (v.consistent) return `Best on ${v.best}, worst on ${v.worst} — and that held in both halves of the history. The only consistent weekday pattern; still borderline, so it is watched on paper.`;
  if (!v.enough) return `Best ${v.best || '–'}, worst ${v.worst || '–'}, but each weekday has too few trades: treat the differences as chance.`;
  return `Best ${v.best || '–'}, worst ${v.worst || '–'}; the pattern did not hold in both halves, so it is probably chance.`;
}

function dpRender(r) {
  if (!r?.strategies) return ($('dpOut').innerHTML = '<div class="note">Not calculated yet: it runs with the Saturday re-tests (or run node paper-bot/day-patterns.mjs).</div>');
  const pick = $('dpLogic');
  if (pick && pick.options.length <= 1) for (const st of r.strategies) pick.add(new Option(st.name, st.key));
  let html = `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Strategy</th>${DP_DAYS.map((d) => `<th>${d}</th>`).join('')}<th>All days</th></tr></thead><tbody>${r.strategies.map((s) =>
    `<tr><td style="text-align:left"><b>${esc(s.name)}</b><div class="note" style="display:block;margin:0">${esc(s.period)}</div></td>${DP_DAYS.map((d) => dpCell(s.byDay[d], s.unit, d === s.verdict?.best || d === s.verdict?.worst)).join('')}${dpCell(s.all, s.unit)}</tr>`).join('')}</tbody></table></div>
    <div class="note">Average per trade (₹ after charges, R = multiples of the risk, % per trade or of margin). Under each: trades · share won · t. <b>Bold</b> = |t| ≥ 2; shaded = that strategy's best and worst day.</div>`;
  html += `<div style="font-size:14px;margin-top:12px"><b>What each line means</b></div><ul style="margin:4px 0 0 18px;padding:0;font-size:13px;line-height:1.6">${r.strategies.map((s) => `<li><b>${esc(s.name)}:</b> ${esc(dpVerdict(s))}</li>`).join('')}</ul>`;

  const gaps = r.strategies.filter((s) => s.byGap);
  if (gaps.length) {
    const kinds = ['gap up', 'flat open', 'gap down'];
    html += `<div style="font-size:14px;margin-top:14px"><b>Intraday strategies by how NIFTY opened</b> <span class="note" style="display:inline">(last ${r.intradaySessions} trading days; gap = more than 0.3% from the previous close)</span></div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Strategy</th>${kinds.map((k) => `<th>${k}</th>`).join('')}</tr></thead><tbody>${gaps.map((s) =>
        `<tr><td style="text-align:left">${esc(s.name)}</td>${kinds.map((k) => dpCell(s.byGap[k], s.unit)).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="note">How NIFTY opens is known at 9:15, so this is usable — but the samples are small. Breakfast losing on gap days is the clearest pattern; it has a "flat opens only" paper version.</div>`;
  }

  const m = r.monday || {};
  if (m.swing?.length) {
    html += `<div style="font-size:14px;margin-top:14px"><b>Monday tests: strong-stock swing</b> <span class="note" style="display:inline">(full NSE history; 2018 onward is the honest test)</span></div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Version</th><th>Monday buys</th><th>Trades</th><th>Per trade</th><th>Per year (after tax)</th><th>2010–17</th><th>2018 →</th><th>Worst fall</th></tr></thead><tbody>${m.swing.map((x) =>
        `<tr><td style="text-align:left">${esc(x.version.replace('Strong-stock swing · ', ''))}</td><td>${esc(x.label)}</td><td>${x.trades}</td><td>${x.avgR >= 0 ? '+' : ''}${x.avgR.toFixed(3)}R</td><td>${dpPc(x.cagr)} (${dpPc(x.cagrAfterTax)})</td><td>${dpPc(x.early)}</td><td>${dpPc(x.late)}</td><td>${dpPc(x.maxDrawdown)}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">Skipping Monday buys helps per trade but throws away good trades too; moving them to Tuesday's open keeps the trades and added a little in both versions. Recorded as the paper version "Monday buys on Tuesday"; live signals are unchanged.</div>`;
  }
  if (m.weekendDip?.length) {
    html += `<div style="font-size:14px;margin-top:12px"><b>Monday tests: NIFTY "weekend dip"</b> <span class="note" style="display:inline">(NIFTY fell on Friday and Monday → buy at Tuesday's open, sell on the bounce)</span></div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Version</th><th>2010–17 per trade</th><th>2018 → per trade</th><th>2018 → per year (after tax)</th><th>NIFTY (after tax)</th></tr></thead><tbody>${m.weekendDip.map((x) =>
        `<tr><td style="text-align:left">${esc(x.label)}</td><td>${dpVal(x.early, '%')} <span class="note" style="display:inline">(${x.early.n})</span></td><td style="color:${dpCol(x.late.avg)}">${dpVal(x.late, '%')} <span class="note" style="display:inline">(${x.late.n})</span></td><td>${dpPc(x.cagr)} (${dpPc(x.cagrAfterTax)})</td><td>${dpPc(x.niftyCagr)} (${dpPc(x.niftyAfterTax)})</td></tr>`).join('')}</tbody></table></div>
      <div class="note">Rejected: about zero per trade and far behind simply holding NIFTY. The NIFTY dip-buy (a 3% fall in 5 days) does the same job better.</div>`;
  }
  if (m.error) html += `<div class="note">Monday swing tests unavailable: ${esc(m.error)}</div>`;
  html += `<div class="note" style="margin-top:10px">${esc(r.note)} Calculated ${esc(String(r.at).slice(0, 10))}.</div>`;
  $('dpOut').innerHTML = html;
}
lazy('Day patterns', async () => {
  try { dpRender(await api('/api/day-patterns')); } catch (e) { $('dpOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});

// --- "What works today?" ---
function dpTodayRender(r) {
  if (r.error) return ($('dpToday').innerHTML = `<div class="note">${esc(r.error)}</div>`);
  const pick = $('dpLogic');
  if (pick.options.length <= 1) for (const l of r.logics) pick.add(new Option(l.name, l.key));
  const fmt = (v, unit) => (v == null ? '–' : dpVal({ n: 1, avg: v }, unit));
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:13px"><b>${esc(r.isToday ? 'Today' : 'Next trading day')}: ${esc(r.weekday)} ${esc(r.date)}</b>${r.gap ? ` · NIFTY opened with a <b>${esc(r.gap)}</b> (${r.gapPct >= 0 ? '+' : ''}${r.gapPct.toFixed(2)}%)` : r.isToday ? ' · opening type known after 9:20' : ''}<div class="note" style="margin:4px 0 0">${esc(r.note)}</div></div>`;
  html += `<div style="overflow-x:auto;margin-top:8px"><table style="font-size:12px"><thead><tr><th style="text-align:left">Logic</th><th>On ${esc(r.weekday)}s</th>${r.gap ? `<th>On ${esc(r.gap)} days</th>` : ''}<th>Usual (all days)</th><th>Verdict</th><th>Last few days (paper)</th></tr></thead><tbody>${r.rows.map((x) =>
    `<tr><td style="text-align:left"><b>${esc(x.name)}</b></td>${dpCell(x.day, x.unit)}${r.gap ? dpCell(x.gap, x.unit) : ''}${dpCell(x.all, x.unit)}<td style="text-align:left;color:${x.reliable ? 'var(--up)' : 'var(--muted)'}">${esc(x.label)}${x.note ? `<div class="note" style="margin:0">${esc(x.note)}</div>` : ''}</td><td style="text-align:left">${x.recent.length ? x.recent.slice(0, 5).map((d) => `${esc(d.date.length === 10 ? d.date.slice(5) : d.date)}: <span style="color:${dpCol(d.result)}">${d.result == null ? '' : fmt(d.result, x.unit)}</span> <span class="note" style="display:inline">${esc(d.detail)}</span>`).join('<br>') : '<span class="note" style="display:inline">no paper trades yet</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  // stocks (or sectors) for each shown logic
  const withStocks = r.rows.filter((x) => x.bestStocks.length || x.sectors.length);
  if (withStocks.length) {
    html += `<div style="font-size:14px;margin-top:10px"><b>Which stocks did best and worst on ${esc(r.weekday)}s</b> <span class="note" style="display:inline">(2+ trades each; tiny samples — a guide to where the logic traded, not a pick)</span></div>`;
    for (const x of withStocks) {
      const list = x.bestStocks.length ? x.bestStocks : x.sectors;
      const kind = x.bestStocks.length ? 'Stock' : 'Sector';
      html += `<div style="font-size:13px;margin-top:6px"><b>${esc(x.name)}</b></div><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">${kind}</th><th>On ${esc(r.weekday)}s</th><th>All days</th></tr></thead><tbody>${[...list, ...(x.bestStocks.length ? x.worstStocks : [])].map((g) =>
        `<tr><td style="text-align:left">${esc(g.symbol)}</td>${dpCell(g.day, x.unit)}${dpCell(g.all, x.unit)}</tr>`).join('')}</tbody></table></div>`;
    }
  }
  $('dpToday').innerHTML = html;
}
async function dpTodayLoad() {
  $('dpTodayBtn').disabled = true;
  $('dpToday').innerHTML = '<div class="note">Checking today\'s weekday, NIFTY\'s opening and each logic\'s record…</div>';
  try {
    const logic = $('dpLogic').value;
    dpTodayRender(await api('/api/day-patterns/today' + (logic ? `?logic=${encodeURIComponent(logic)}` : '')));
  } catch (e) {
    $('dpToday').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('dpTodayBtn').disabled = false;
  }
}
$('dpTodayBtn').addEventListener('click', dpTodayLoad);
$('dpLogic').addEventListener('change', () => { if ($('dpToday').innerHTML) dpTodayLoad(); });
