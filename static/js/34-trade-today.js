// 34-trade-today.js — Home → Trade today?: Go / Be careful / Stay out for each kind of trading, from tested warning signs.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const TT_LV = { go: ['🟢 GO', 'var(--up)'], careful: ['🟡 BE CAREFUL', 'var(--warn)'], stay: ['🔴 STAY OUT', 'var(--down)'] };
const ttPc = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const ttDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function ttRender(r) {
  const head = { stay: 'A risky day — sit out the trades marked STAY OUT below', careful: 'Some warning signs — be careful and trade smaller', go: 'No warning signs — a normal day' }[r.overall];
  const [, col] = TT_LV[r.overall];
  const v = r.values;
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid ${col};font-size:14px"><b style="color:${col}">${esc(head)}</b> · for <b>${esc(ttDate(r.forSession))}</b> <span class="note" style="display:inline">(from the ${esc(r.asOf)} close)</span>
    <div style="font-size:13px;margin-top:4px">${r.signs.length ? `Warning signs: ${r.signs.map((s) => esc(s.text)).join(' · ')}` : 'No warning signs at the last close.'}</div>
    <div class="note" style="margin:4px 0 0">NIFTY ${v.close.toFixed(0)} (${v.move >= 0 ? '+' : ''}${(v.move * 100).toFixed(2)}%, 200-day avg ${v.sma200.toFixed(0)}) · India VIX ${v.vix.toFixed(1)} (${v.vixChange >= 0 ? '+' : ''}${(v.vixChange * 100).toFixed(1)}%, higher than ${Math.round(v.vixRank * 100)}% of the past year) · ${v.downDays} down day${v.downDays === 1 ? '' : 's'} in a row</div></div>`;
  html += `<div style="overflow-x:auto"><table style="font-size:12px;margin-top:8px"><thead><tr><th style="text-align:left">Kind of trade</th><th>Today</th><th style="text-align:left">What to do</th><th>How often it went wrong after a day like this (2019→)</th><th>Down next day: like today / all days</th></tr></thead><tbody>${r.kinds.map((k) => {
    const [tag, c] = TT_LV[k.level];
    const odds = k.untested || k.badNow == null ? '–' : `<b>${ttPc(k.badNow)}</b> had ${esc(k.outcome)}${k.level !== 'go' ? ` · ${ttPc(k.badGo)} on GO days` : ''} <span class="note" style="display:inline">(${k.sample} days)</span>`;
    return `<tr><td style="text-align:left"><b>${esc(k.name)}</b></td><td style="color:${c};white-space:nowrap"><b>${tag}</b></td><td style="text-align:left">${esc(k.advice)}${k.because.length ? `<div class="note" style="margin:2px 0 0">Because: ${k.because.map(esc).join('; ')}</div>` : ''}</td><td>${odds}</td><td>${ttPc(k.downNow)} / ${ttPc(k.downAll)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
  const t = r.tests.byKind;
  html += `<div class="note">Tested on every NIFTY day from ${esc(r.tests.from)}: rules picked on 2010–18, checked once on 2019→. Intraday — wild next day after GO / CAREFUL / STAY OUT days: ${ttPc(t.intraday.holdout.go.bad)} / ${ttPc(t.intraday.holdout.careful.bad)} / ${ttPc(t.intraday.holdout.stay.bad)}. F&O selling — 2%+ week: ${ttPc(t.fnoSell.holdout.go.bad)} / ${ttPc(t.fnoSell.holdout.stay.bad)}. The "down next day" column shows why this can't call direction: it stays near ${ttPc(t.intraday.holdout.all.down)} after every sign.</div>
    <div class="note">${esc(r.note)}</div>`;
  $('ttOut').innerHTML = html;
}
lazy('Trade today?', async () => {
  try { ttRender(await api('/api/trade-today')); } catch (e) { $('ttOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
