// 50-afternoon-trend.js — Options & risk → Afternoon trend (option buying): the loop-23 option-buying near-miss "T1",
// replayed after the close from 5-minute bars, PAPER ONLY (paper-bot/afternoon-trend.mjs). Shows the expiry context,
// the scorecard (vs an arbitrage fund and NIFTY, after tax), the last 10 trades, recent days and the research.
// Classic script (not a module).
const atRs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const atAmt = (v) => `₹${Math.round(v || 0).toLocaleString('en-IN')}`;
const atPc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}%`);
const atCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
const atDay = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '–');
const atSide = (t) => (t === 'CE' ? 'call' : t === 'PE' ? 'put' : '');

function atRender(d) {
  const s = d.summary;
  let html = '';
  // expiry context (the full warning box is added above by 48-expiry.js)
  const x = d.expiry;
  if (x) {
    html += `<div class="note" style="margin-top:0">${x.niftyExpiry
      ? `<b style="color:var(--down)">Next session (${esc(atDay(x.session))}) is a NIFTY expiry day: no trade that day, whatever the signal.</b>`
      : `Next session ${esc(atDay(x.session))}: not a NIFTY expiry day — the rule may trade if the 12:25 signal comes.`} Next NIFTY weekly expiry: ${esc(atDay(x.next))}.</div>`;
  }
  // scorecard
  if (!d.startedAt) {
    html += '<div class="note">The paper record has not started yet: it opens on the first evening run and starts from the next trading day.</div>';
  } else {
    html += `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px"><b>Paper since ${esc(atDay(d.startedAt))}</b> · ${s.sessions} session${s.sessions === 1 ? '' : 's'} recorded${d.dataTo ? ` (to ${esc(atDay(d.dataTo))})` : ''} · account ${atAmt(s.equity)} <span style="color:${atCol(s.totalRs)}">(${atRs(s.totalRs)})</span> from ₹1,00,000
      <div style="margin-top:4px;font-size:13px"><b>${esc(d.verdict)}</b> ${s.n} trade${s.n === 1 ? '' : 's'} so far.</div></div>`;
    html += `<div style="overflow-x:auto;margin-top:6px"><table style="font-size:12px;width:100%"><tbody>
      <tr><td style="text-align:left;white-space:normal">Trades · win rate</td><td><b>${s.n}</b> · ${s.winRate == null ? '–' : `${Math.round(s.winRate * 100)}%`}</td></tr>
      <tr><td style="text-align:left;white-space:normal">Average per trade (after costs)</td><td style="color:${atCol(s.avgRetPct)}">${atPc(s.avgRetPct)}</td></tr>
      <tr><td style="text-align:left;white-space:normal">₹ total (before tax)</td><td style="color:${atCol(s.totalRs)}"><b>${atRs(s.totalRs)}</b></td></tr>
      <tr><td style="text-align:left;white-space:normal">Day-clustered t (${s.tradeDays} trade day${s.tradeDays === 1 ? '' : 's'})</td><td>${s.tDay == null ? '– (needs 2+ days)' : s.tDay.toFixed(2)}</td></tr>
      <tr><td style="text-align:left;white-space:normal">After tax (business income 31.2%, by financial year)</td><td style="color:${atCol(s.afterTax.pnl)}">${atRs(s.afterTax.pnl)}${s.afterTax.tax ? ` (tax ${atAmt(s.afterTax.tax)})` : ''}</td></tr>
      <tr><td style="text-align:left;white-space:normal">Same ₹1 lakh in an arbitrage fund (≈6.5%/yr, after tax)</td><td>${atRs(s.arbitrage.afterTax)}</td></tr>
      <tr><td style="text-align:left;white-space:normal">Same ₹1 lakh in NIFTY 50 (index, before tax)</td><td style="color:${atCol(s.nifty?.rs)}">${s.nifty ? `${atRs(s.nifty.rs)} (${atPc(s.nifty.ret * 100, 2)})` : '–'}</td></tr>
      <tr><td style="text-align:left;white-space:normal">Exits: stop / target / 15:15 · worst fall</td><td>${s.exits.stop} / ${s.exits.target} / ${s.exits.time} · ${(s.maxDrawdown * 100).toFixed(1)}%</td></tr>
      <tr><td style="text-align:left;white-space:normal">Days skipped</td><td style="text-align:right">${Object.entries(s.skips).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') || '–'}</td></tr>
      </tbody></table></div>`;
  }
  const row = (t) => `<tr><td style="text-align:left">${esc(atDay(t.date))}${t.test ? ' <span class="note" style="display:inline">TEST</span>' : ''}</td><td>${esc(atSide(t.type))}</td><td>${esc(String(t.strike))} · ${esc(t.expiry)}</td><td>${t.lots}</td><td>${esc(t.entry.time)} ₹${t.entry.price.toFixed(2)}</td><td>${esc(t.exit.why)} ${esc(t.exit.time)} ₹${t.exit.price.toFixed(2)}</td><td style="color:${atCol(t.ret)}">${atPc(t.ret * 100)}</td><td style="color:${atCol(t.pnl)}"><b>${atRs(t.pnl)}</b></td></tr>`;
  const head = '<thead><tr><th style="text-align:left">Day</th><th>Side</th><th>Strike · expiry</th><th>Lots</th><th>Bought</th><th>Sold</th><th>Return</th><th>₹ after costs</th></tr></thead>';
  html += `<div style="font-size:14px;margin-top:12px"><b>Last 10 trades</b></div>`;
  html += d.trades.length ? `<div style="overflow-x:auto"><table style="font-size:12px">${head}<tbody>${d.trades.map(row).join('')}</tbody></table></div>` : '<div class="note">No paper trades yet — most days have no signal.</div>';
  if (d.recentDays.length) {
    html += `<div class="note"><b>Recent sessions:</b> ${d.recentDays.map((x) => `${esc(atDay(x.date))} — ${x.status === 'trade' ? `${esc(atSide(x.type))} trade ${atRs(x.pnl)}` : esc(x.reason)}`).join(' · ')}</div>`;
  }
  if (d.tests.length) {
    html += `<div class="note"><b>Test entries (backfilled with --date, not scored):</b> ${d.tests.map((x) => `${esc(atDay(x.date))} — ${x.signal?.type ? `signal ${esc(atSide(x.signal.type))} (NIFTY ${atPc(x.signal.move * 100, 2)} at 12:25) → ` : ''}${x.status === 'trade' ? `${esc(String(x.strike))} ${esc(atSide(x.type))} ${atRs(x.pnl)}` : esc(x.reason)}`).join(' · ')}</div>`;
  }
  // research
  const R = d.research;
  html += `<div style="font-size:14px;margin-top:12px"><b>How it was tested</b> — ${esc(R.name)}</div>
    <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Period</th><th>Per trade</th><th>t</th><th>Trades</th><th style="text-align:left">Result</th></tr></thead><tbody>${R.rows.map((x) =>
    `<tr><td style="text-align:left">${esc(x.period)} <span class="note" style="display:inline">(${esc(x.seen)})</span></td><td style="color:${atCol(x.perTrade)}"><b>${atPc(x.perTrade)}</b></td><td>${x.t == null ? '–' : x.t.toFixed(2)}</td><td>${x.n ?? '–'}</td><td style="text-align:left">${esc(x.note)}</td></tr>`).join('')}</tbody></table></div>
    <div class="note">Verdict: ${esc(R.verdict)}. ${esc(R.sebi)} ${esc(R.frozen)}</div>`;
  html += `<div class="note"><b>Rules (frozen):</b> ${d.rules.map(esc).join(' ')}</div>`;
  html += `<div class="note">${esc(d.replay)} ${esc(d.note)}</div>`;
  $('atOut').innerHTML = html;
}
lazy('Afternoon trend', async () => {
  try { atRender(await api('/api/afternoon-trend')); } catch (e) { $('atOut').innerHTML = `<div class="err">Error: ${esc(e.message)}. Not advice.</div>`; }
});
