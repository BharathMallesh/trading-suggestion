// 35-fo-plan.js — Options & risk → My F&O plan: progress to 20–30 paper trades, the decision, today's checklist.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const FP_TONE = { practise: ['🟡 PRACTISE ON PAPER', 'var(--warn)'], 'early-good': ['🟢 EARLY READ: POSITIVE', 'var(--up)'], 'early-bad': ['🟠 EARLY READ: NEGATIVE', 'var(--warn)'], 'go-small': ['🟢 PASSED: TRY SMALL REAL MONEY', 'var(--up)'], stop: ['🔴 STOP F&O', 'var(--down)'] };
const fpRs = (v) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const fpPc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);

function fpRender(r) {
  if (!r.ready) {
    $('fpOut').innerHTML = `<div class="note">${esc(r.note)}</div>`;
    return;
  }
  const p = r.progress;
  const [tag, col] = FP_TONE[r.decision.status] || ['–', 'var(--muted)'];
  const bar = Math.min(1, p.closed / p.decide);
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid ${col};font-size:14px"><b style="color:${col}">${tag}</b><div style="margin-top:4px">${esc(r.decision.text)}</div>
    <div style="margin-top:8px;height:8px;border-radius:4px;background:var(--soft);overflow:hidden"><div style="width:${Math.round(bar * 100)}%;height:100%;background:${col}"></div></div>
    <div class="note" style="margin:4px 0 0">${p.closed} of ${p.decide} closed trades (an early read at ${p.early}) · since ${esc(r.startedAt)}</div></div>`;
  const box = (label, value, sub, tone) => `<div style="flex:1 1 140px;padding:8px 10px;border:1px solid var(--line);border-radius:10px"><div class="note" style="margin:0">${label}</div><div style="font-size:18px;font-weight:700;color:${tone > 0 ? 'var(--up)' : tone < 0 ? 'var(--down)' : 'var(--ink)'}">${value}</div><div class="note" style="margin:0">${sub}</div></div>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
    ${box('Account (paper)', `₹${Math.round(p.value).toLocaleString('en-IN')}`, `${fpPc(p.ret)} from ₹${r.capital.toLocaleString('en-IN')}`, Math.sign(p.ret))}
    ${box('Closed trades', `${p.closed}`, p.closed ? `${p.wins} won (${Math.round(p.winRate * 100)}%) · ${fpRs(p.net)}` : 'none yet', Math.sign(p.net))}
    ${box('Holding NIFTY instead', fpPc(p.niftyRet), 'same time, for comparison', 0)}
    ${box('Worst fall', `${Math.round(p.worstFall * 100)}%`, `stop at ${r.plan.stopAtPct}%`, p.worstFall >= r.plan.stopAtPct / 100 ? -1 : 0)}
  </div>`;
  html += `<div style="font-size:14px;margin-top:10px"><b>Today's checklist</b></div><table style="font-size:12px"><tbody>${r.checklist.map((c) => `<tr><td style="white-space:nowrap">${c.ok == null ? '⚪' : c.ok ? '✅' : '❌'}</td><td style="text-align:left">${esc(c.rule)}</td><td style="text-align:left" class="note">${esc(c.detail)}</td></tr>`).join('')}</tbody></table>
    <div class="note">Check yourself: ${r.manual.map(esc).join(' · ')}.</div>`;
  html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px"><b>The plan, step by step</b></summary><ol style="margin:4px 0 0 18px;padding:0;font-size:13px;line-height:1.6">
    <li><b>Practise on paper</b> — the Spread paper tracker below buys the best-odds spreads each evening by these rules (max ₹${r.rules.perTrade.toLocaleString('en-IN')} to lose a trade, ${r.rules.maxOpen} open, ${r.rules.maxPerSide} the same way, no STAY OUT days).</li>
    <li><b>Early read at ${r.plan.early} closed trades</b>, the <b>decision at ${r.plan.decide}</b>: real money only if the record made money after charges and beat holding NIFTY over the same time.</li>
    <li><b>Passed</b> → the same small size and rules with real money; keep checking this card. Never raise the size until the real record also stays positive for months.</li>
    <li><b>Not passed, or a ${r.plan.stopAtPct}% fall</b> → stop F&amp;O and put the ₹${r.capital.toLocaleString('en-IN')} in a tested monthly portfolio (Home → Do this month: Momentum 10 or India mix).</li></ol></details>
    <div class="note">${esc(r.note)}${p.skippedDays ? ` STAY OUT days skipped so far: ${p.skippedDays}.` : ''}</div>`;
  $('fpOut').innerHTML = html;
}
lazy('My F&O plan', async () => {
  try { fpRender(await api('/api/fo-plan')); } catch (e) { $('fpOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
