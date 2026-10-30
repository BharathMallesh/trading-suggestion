// 27-imbalance-swing.js — Trading strategies → Imbalance swing: 16-year test, the interview's measures, live scan, paper record.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const ibF = (x, d = 2) => (x == null ? '–' : x.toFixed(d));
const ibPc = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const ibCol = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');

function ibRender(d) {
  const b = d.backtest;
  const p = d.paper;
  let html = '';
  if (b) {
    const v = b.byPeriod;
    const ps = [['dev', '2010–17'], ['val', '2018–22'], ['holdout', '2023→']];
    html += `<div style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid ${b.passed ? 'var(--up)' : 'var(--warn)'};font-size:13px"><b>${esc(b.verdict)}</b>
      <div class="note" style="margin:4px 0 0">The edge per trade is real and looks like the interview describes (about a third of trades win, winners about 3× the losers, a few big winners). But with only about 20 trades a year the money is idle most of the time, so the whole account earned about what NIFTY did.</div></div>`;
    const row = (label, f) => `<tr><td style="text-align:left">${label}</td>${ps.map(([k]) => `<td>${f(v[k])}</td>`).join('')}</tr>`;
    html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">After charges</th>${ps.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
      ${row('Trades (a year)', (x) => `${x.trades} (${ibF(x.perYear, 0)})`)}
      ${row('Won (win rate)', (x) => ibPc(x.winRate, 0))}
      ${row('<b>Average per trade</b>', (x) => `<b style="color:${ibCol(x.avgR)}">${ibF(x.avgR)} R</b> <span class="note" style="display:inline">t ${ibF(x.tStat, 1)}</span>`)}
      ${row('Average win ÷ average loss', (x) => `${ibF(x.avgWinR)} R ÷ ${ibF(x.avgLossR)} R = ${ibF(x.winLossRatio, 1)}`)}
      ${row('Largest winner / loser', (x) => `${ibF(x.bestR, 1)} R / ${ibF(x.worstR, 1)} R`)}
      ${row('Losses (≥ 30 to judge)', (x) => `${x.losses}${x.enoughLosses ? ' ✓' : ''}`)}
      ${row('Skew (positive = big winners)', (x) => ibF(x.skew, 1))}
      ${row('<b>Account at 1% risk, a year</b>', (x) => `<b style="color:${ibCol(x.cagr)}">${ibPc(x.cagr)}</b>`)}
      ${row('Worst fall', (x) => `<span style="color:var(--down)">${ibPc(x.maxDrawdown, 0)}</span>`)}
      ${row('NIFTY, a year', (x) => ibPc(x.niftyCagr))}
      </tbody></table></div>`;
    if (b.best?.length) html += `<div class="note">Biggest winners: ${b.best.map((t) => `${esc(t.symbol)} ${ibF(t.r, 1)} R (${esc(t.entryDate)})`).join(' · ')}</div>`;
    html += `<div class="note">${esc(b.note)}</div>`;
  } else html += '<div class="note">Backtest not run yet (it runs with the Saturday re-tests).</div>';
  if (p) {
    const s = p.scan || { triggered: [], forming: [] };
    html += `<div style="font-size:14px;margin-top:12px"><b>Live scan</b> (NSE close of ${esc(s.date || '–')})</div>
      <div style="font-size:13px">${s.triggered.length ? `Entry signals — bought at the next open on paper: ${s.triggered.map((x) => `<b>${esc(x.symbol)}</b> (move +${ibF(x.movePct, 0)}%, stop ₹${ibF(x.stop, 1)}, risk ${ibF(x.riskPct, 1)}%)`).join(' · ')}` : 'No breakout signal at the latest close.'}</div>
      ${s.forming.length ? `<div class="note">Bases forming (a move and a quiet base, waiting for a breakout): ${s.forming.map((x) => `${esc(x.symbol)} +${ibF(x.movePct, 0)}% · base ${x.baseDays}d · breakout above ₹${ibF(x.triggerAbove, 1)}`).join(' · ')}</div>` : '<div class="note">No bases forming right now.</div>'}`;
    const open = p.trades.filter((t) => t.open);
    html += `<div style="font-size:14px;margin-top:10px"><b>Paper record</b> since ${esc(p.startedAt)}: ${p.summary?.trades ? `${p.summary.trades} closed · won ${ibPc(p.summary.winRate, 0)} · ${ibF(p.summary.avgR)} R a trade` : 'no closed trades yet'}${open.length ? ` · open: ${open.map((t) => `${esc(t.symbol)} (stop ₹${ibF(t.trail, 1)})`).join(', ')}` : ''}</div>`;
    if (p.trades.length) html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Entry</th><th>Stop now</th><th>Exit</th><th>Why</th><th>Result</th></tr></thead><tbody>${p.trades.map((t) =>
      `<tr><td style="text-align:left">${esc(t.symbol)}</td><td>${esc(t.entryDate)}</td><td>₹${ibF(t.entry, 1)}</td><td>₹${ibF(t.trail, 1)}</td><td>${t.open ? '–' : `₹${ibF(t.exit, 1)}`}</td><td>${esc(t.reason)}</td><td style="color:${ibCol(t.r)}"><b>${t.r >= 0 ? '+' : ''}${ibF(t.r)} R</b></td></tr>`).join('')}</tbody></table></div>`;
  }
  $('imbOut').innerHTML = html;
}
lazy('Imbalance swing', async () => {
  try { ibRender(await api('/api/imbalance-swing')); } catch (e) { $('imbOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
