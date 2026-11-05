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
  const h = r.history;
  if (h) {
    const v = h.variants.rules;
    html += `<div style="margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--down);font-size:13px"><b>Tested on real NSE option prices</b> (${esc(h.from)} → ${esc(h.to)}, ${h.cycles} months): <b style="color:${v.all.total >= 0 ? 'var(--up)' : 'var(--down)'}">${fpRs(v.all.total)}</b> over ${v.all.trades} trades — won ${Math.round(v.all.winRate * 100)}% when the odds said ${Math.round(v.all.expectedWinRate * 100)}%.
      ${v.stoppedAt ? `The 30% stop would have ended the plan on ${esc(v.stoppedAt)}. ` : ''}Months up: ${v.monthsUp} of ${v.months}. ${v.puts.trades ? `Put spreads on WEAK stocks: ${v.puts.trades}, won ${Math.round(v.puts.winRate * 100)}%, ${fpRs(v.puts.total)}. ` : ''}${v.calls.trades ? `Call spreads on STRONG stocks: ${v.calls.trades} (few fit ₹3,000), ${fpRs(v.calls.total)}.` : ''}
      <details style="margin-top:6px"><summary style="cursor:pointer">All variants</summary><table style="font-size:12px"><thead><tr><th style="text-align:left">Variant</th><th>Trades</th><th>Won</th><th>Result</th><th>Without the best 2</th><th>2024–25 / 2025–26</th></tr></thead><tbody>${Object.values(h.variants).map((x) => `<tr><td style="text-align:left">${esc(x.label)}</td><td>${x.all.trades}</td><td>${Math.round((x.all.winRate || 0) * 100)}%</td><td style="color:${x.all.total >= 0 ? 'var(--up)' : 'var(--down)'}">${fpRs(x.all.total || 0)}</td><td>${fpRs(x.all.withoutBest2 || 0)}</td><td>${fpRs(x.dev.total || 0)} / ${fpRs(x.holdout.total || 0)}</td></tr>`).join('')}</tbody></table>
      <div class="note">Bought at the close of the first session after each monthly expiry with the same rules and only what was known that day; sold at the real option closes 2 sessions before expiry; all charges. The one variant that ended up (ranked by the replay average) made it from 2 lucky trades — without them it lost too. So there is no change to the rules: the paper record is the next check, and the plan's decision rule still applies.</div></details></div>`;
  }
  const iv = r.intraday;
  if (iv) {
    const col = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
    const rows = Object.values(iv.results).filter((x) => x.all?.trades);
    html += `<div style="margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:13px"><b>NIFTY options on real 5-minute option prices</b> <span class="note" style="display:inline">(${esc(iv.from)} → ${esc(iv.to)}, ${iv.weeks} weekly expiries, 1 lot of ${iv.lot}, after charges; 2020–22 / 2023 →)</span>
      <div style="overflow-x:auto"><table style="font-size:12px;margin-top:4px;white-space:nowrap"><thead><tr><th style="text-align:left">Strategy</th><th>Trades</th><th>Won</th><th>Result</th><th>Per trade</th><th>Worst</th><th>2020–22</th><th>2023 →</th></tr></thead><tbody>${rows.map((x) =>
        `<tr><td style="text-align:left">${esc(x.label)}</td><td>${x.all.trades}</td><td>${Math.round(x.all.winRate * 100)}%</td><td style="color:${col(x.all.total)}"><b>${fpRs(x.all.total)}</b></td><td>${fpRs(x.all.avg)} <span class="note" style="display:inline">t ${x.all.tStat?.toFixed(1)}</span></td><td style="color:var(--down)">${fpRs(x.all.worst)}</td><td style="color:${col(x.early.total)}">${fpRs(x.early.total || 0)}</td><td style="color:${col(x.late.total)}">${fpRs(x.late.total || 0)}</td></tr>`).join('')}</tbody></table></div>
      <div class="note" style="margin:4px 0 0">Entries, stops and targets checked on real 5-minute option prices (Groww), exits at the close of the bar that triggered them. Sold strangles and condors need far more than ₹10,000 of margin — shown to judge the idea, not as a fit for this account.</div></div>`;
  }
  html += `<div style="font-size:14px;margin-top:10px"><b>Today's checklist</b></div><table style="font-size:12px"><tbody>${r.checklist.map((c) => `<tr><td style="white-space:nowrap">${c.ok == null ? '⚪' : c.ok ? '✅' : '❌'}</td><td style="text-align:left">${esc(c.rule)}</td><td style="text-align:left" class="note">${esc(c.detail)}</td></tr>`).join('')}</tbody></table>
    <div class="note">Check yourself: ${r.manual.map(esc).join(' · ')}.</div>`;
  html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px"><b>The plan, step by step</b></summary><ol style="margin:4px 0 0 18px;padding:0;font-size:13px;line-height:1.6">
    <li><b>Practise on paper</b> — the Spread paper tracker (Options &amp; risk tab) buys the best-odds spreads each evening by these rules (max ₹${r.rules.perTrade.toLocaleString('en-IN')} to lose a trade, ${r.rules.maxOpen} open, ${r.rules.maxPerSide} the same way, no STAY OUT days).</li>
    <li><b>Early read at ${r.plan.early} closed trades</b>, the <b>decision at ${r.plan.decide}</b>: real money only if the record made money after charges and beat holding NIFTY over the same time.</li>
    <li><b>Passed</b> → the same small size and rules with real money; keep checking this card. Never raise the size until the real record also stays positive for months.</li>
    <li><b>Not passed, or a ${r.plan.stopAtPct}% fall</b> → stop F&amp;O and put the ₹${r.capital.toLocaleString('en-IN')} in a tested monthly portfolio (Home → Do this month: Momentum 10 or India mix).</li></ol></details>
    <div class="note">${esc(r.note)}${p.skippedDays ? ` STAY OUT days skipped so far: ${p.skippedDays}.` : ''}</div>`;
  $('fpOut').innerHTML = html;
}
lazy('My F&O plan', async () => {
  try { fpRender(await api('/api/fo-plan')); } catch (e) { $('fpOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
