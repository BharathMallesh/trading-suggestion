// 36-calendar.js — Day patterns → Calendar: month of the year, weekday, market holidays, start / middle / end of
// the month — for NIFTY, the average NSE top-200 stock and each strategy. From the Day patterns study (weekly refit).
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const calPc = (x, d = 2) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const calCol = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');
/** "+0.20% · 56% up" for one cell; bold when |t| ≥ 2. */
const calCell = (s, d = 2) => (s?.n ? `<span style="color:${calCol(s.avg)}">${Math.abs(s.t ?? 0) >= 2 ? '<b>' : ''}${calPc(s.avg, d)}${Math.abs(s.t ?? 0) >= 2 ? '</b>' : ''}</span> <span class="note" style="display:inline">${Math.round(s.win * 100)}% up</span>` : '–');
const calRow = (label, x, d = 2) => `<tr><td style="text-align:left">${label}</td><td>${calCell(x?.all, d)}</td><td>${calCell(x?.early, d)}</td><td>${calCell(x?.late, d)}</td><td>${x?.consistent ? '✓' : ''}</td></tr>`;
const calHead = (first, what) => `<thead><tr><th style="text-align:left">${first}</th><th>${what}: all years</th><th>2008–16</th><th>2017 →</th><th>both</th></tr></thead>`;

function calRender(d) {
  const c = d.calendar;
  if (!c) {
    $('calOut').innerHTML = '<div class="note">Not calculated yet — it runs with the Saturday re-tests.</div>';
    return;
  }
  const n = c.nifty;
  const s = c.stocks;
  const months = CAL_MONTHS.map((m) => ({ m, x: n.monthOfYear[m] })).filter((o) => o.x?.all?.n);
  const best = [...months].sort((a, b) => b.x.all.avg - a.x.all.avg).slice(0, 2);
  const worst = [...months].sort((a, b) => a.x.all.avg - b.x.all.avg).slice(0, 2);
  const tom = c.turnOfMonth;
  const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:13px;line-height:1.6"><b>In short</b> (NSE ${esc(c.from)} → ${esc(c.to)}: ${c.days.toLocaleString('en-IN')} trading days, ${c.holidays} market holidays)
    <ul style="margin:4px 0 0 18px;padding:0">
      <li><b>Months:</b> best on average ${best.map((o) => `${o.m} (${calPc(o.x.all.avg, 1)}, up ${Math.round(o.x.all.win * 100)}% of years)`).join(', ')}; weakest ${worst.map((o) => `${o.m} (${calPc(o.x.all.avg, 1)})`).join(', ')}. ${CAL_MONTHS.filter((m) => s.month[m]?.consistent).length ? `Held in both halves for the average stock: <b>${CAL_MONTHS.filter((m) => s.month[m]?.consistent).join(', ')}</b>.` : ''} Only ~18 of each month, so treat these as tilts.</li>
      <li><b>Part of the month:</b> the last trading day and the first 1–2 days carry most of the gains (first day: NIFTY ${calPc(n.turn['1']?.all?.avg)}, average stock ${calPc(s.turn['1']?.all?.avg)} vs ${calPc(s.all.all.avg, 3)} on an average day); the middle (days 6–15) is about zero.</li>
      <li><b>Holidays:</b> the day before a market holiday rose ${Math.round((n.holiday['day before a holiday']?.all?.win ?? 0) * 100)}% of the time (${calPc(n.holiday['day before a holiday']?.all?.avg)}) vs ${Math.round((n.holiday['other days']?.all?.win ?? 0) * 100)}% on other days — strong in 2008–16, weaker since.</li>
      <li><b>Weekdays:</b> small differences (about 0.1%); Wednesday has been best, Monday / Thursday weakest.</li>
      ${tom?.late ? `<li><b>Can you trade it?</b> Holding NIFTY only 4 days around each month-end (cash at 6% otherwise, 0.25% costs) made ${pct(tom.early?.perYear)} a year in 2008–16 but ${pct(tom.late.perYear)} since 2017 — less than simply holding NIFTY (${pct(tom.late.buyHoldPerYear)}). Timing the calendar has not beaten staying invested.</li>` : ''}
    </ul></div>`;
  html += `<div style="font-size:14px;margin-top:12px"><b>Month of the year</b> <span class="note" style="display:inline">(NIFTY's return over the whole month; bold = |t| ≥ 2)</span></div>
    <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap">${calHead('Month', 'NIFTY month')}<tbody>${CAL_MONTHS.map((m) => calRow(m, n.monthOfYear[m], 1)).join('')}</tbody></table></div>
    <details open style="margin-top:4px"><summary style="cursor:pointer;font-size:13px">The average stock, by month (daily moves)</summary><table style="font-size:12px;white-space:nowrap">${calHead('Month', 'stock a day')}<tbody>${CAL_MONTHS.map((m) => calRow(m, s.month[m], 3)).join('')}</tbody></table></details>`;
  const P = ['start (days 1–5)', 'middle (days 6–15)', 'end (day 16 → last)'];
  html += `<div style="font-size:14px;margin-top:12px"><b>Start, middle and end of the month</b> <span class="note" style="display:inline">(a day's move)</span></div>
    <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap">${calHead('Part of the month', 'NIFTY')}<tbody>${P.map((p) => calRow(p, n.phase[p], 3)).join('')}</tbody></table></div>
    <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap;margin-top:6px"><thead><tr><th style="text-align:left">Trading day</th>${[-5, -4, -3, -2, -1, 1, 2, 3, 4, 5].map((t) => `<th>${t < 0 ? `last${t === -1 ? '' : ` ${t}`}` : `day ${t}`}</th>`).join('')}</tr></thead><tbody>
      <tr><td style="text-align:left">NIFTY</td>${[-5, -4, -3, -2, -1, 1, 2, 3, 4, 5].map((t) => `<td>${calCell(n.turn[t]?.all, 2)}</td>`).join('')}</tr>
      <tr><td style="text-align:left">Average stock</td>${[-5, -4, -3, -2, -1, 1, 2, 3, 4, 5].map((t) => `<td>${calCell(s.turn[t]?.all, 2)}${s.turn[t]?.consistent ? ' ✓' : ''}</td>`).join('')}</tr></tbody></table></div>
    <div class="note">"last" = the month's last trading day, "last −2" = two days before it; "day 1" = the next month's first trading day.</div>`;
  const H = ['day before a holiday', 'day after a holiday', 'other days'];
  html += `<div style="font-size:14px;margin-top:12px"><b>Around market holidays</b> <span class="note" style="display:inline">(NSE closed on a weekday; ${c.holidays} since 2008)</span></div>
    <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap">${calHead('Day', 'NIFTY')}<tbody>${H.map((h) => calRow(h, n.holiday[h], 3)).join('')}</tbody></table></div>
    <details open style="margin-top:4px"><summary style="cursor:pointer;font-size:13px">The average stock around holidays</summary><table style="font-size:12px;white-space:nowrap">${calHead('Day', 'stock')}<tbody>${H.map((h) => calRow(h, s.holiday[h], 3)).join('')}</tbody></table></details>`;
  html += `<div style="font-size:14px;margin-top:12px"><b>Weekday</b></div>
    <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap">${calHead('Day', 'NIFTY')}<tbody>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((w) => calRow(w, n.weekday[w], 3)).join('')}</tbody></table></div>`;
  // the app's strategies by part of the month / holiday / month
  const st = (d.strategies || []).filter((x) => x.calendar);
  if (st.length) {
    const v = (x, unit) => (x?.all?.n ? `<span style="color:${calCol(x.all.avg)}">${unit === '₹' ? `${x.all.avg < 0 ? '−' : '+'}₹${Math.abs(Math.round(x.all.avg))}` : `${x.all.avg >= 0 ? '+' : ''}${x.all.avg.toFixed(2)}${unit === 'R' ? 'R' : '%'}`}</span> <span class="note" style="display:inline">(${x.all.n})</span>` : '–');
    html += `<div style="font-size:14px;margin-top:12px"><b>Your strategies by part of the month and holidays</b> <span class="note" style="display:inline">(average per trade, by the day it was bought; trades in brackets)</span></div>
      <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Strategy</th>${P.map((p) => `<th>${p.split(' (')[0]}</th>`).join('')}${H.map((h) => `<th>${h.replace('day ', '')}</th>`).join('')}</tr></thead><tbody>${st.map((x) =>
        `<tr><td style="text-align:left">${esc(x.name)}</td>${P.map((p) => `<td>${v(x.calendar.phase[p], x.unit)}</td>`).join('')}${H.map((h) => `<td>${v(x.calendar.holiday[h], x.unit)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <details open style="margin-top:4px"><summary style="cursor:pointer;font-size:13px">Your strategies by month</summary><div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Strategy</th>${CAL_MONTHS.map((m) => `<th>${m}</th>`).join('')}</tr></thead><tbody>${st.map((x) =>
        `<tr><td style="text-align:left">${esc(x.name)}</td>${CAL_MONTHS.map((m) => `<td>${v(x.calendar.month[m], x.unit)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
      <div class="note">The intraday strategies lost in every month and every part of the month — no timing rescues them. The strong-stock swing did best on buys in the second half of the month. A month has few trades per strategy, so single cells are noisy.</div>`;
  }
  html += `<div class="note" style="margin-top:8px">Market holidays and trading days are NSE's own (a weekday without an NSE file). NIFTY = daily closes; the average stock = the NSE top 200 of that month, equal weight. "both" ✓ = same direction with |t| ≥ 2 in 2008–16 and in 2017 →. Calculated ${esc(String(d.at).slice(0, 10))}. Research only.</div>`;
  $('calOut').innerHTML = html;
}
lazy('Calendar', async () => {
  try { calRender(await api('/api/day-patterns')); } catch (e) { $('calOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
