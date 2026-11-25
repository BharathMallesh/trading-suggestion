// 48-expiry.js — the expiry-day warning: a red (expiry day) / amber (the day before) banner at the top of Home (only on
// those days), of Options & risk and My F&O plan (always; a one-line "next expiries" note on other days), and inside the
// F&O cards (F&O risk check, Fits my budget, Spread paper tracker, Option strike guide, My F&O plan).
// Classic script (not a module): loaded in order by index.html after 01-core.js and 06-home-views.js (which calls expiryShow).
let XP = null;
let XP_AT = 0;
let XP_VIEW = null;
const XP_CARDS = ['foRiskCard', 'foBudgetCard', 'spreadPaperCard', 'afternoonCard', 'cpTournamentCard', 'strikeCard', 'foPlanCard'];
const xpDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function xpNext(s) {
  const gap = s.next.some((n) => n.unverified?.length);
  return s.next.map((n) => `${esc(n.index === 'STOCKS' ? 'stock options' : n.index)} ${esc(xpDay(n.weekly || n.monthly))}${n.unverified?.includes(n.weekly || n.monthly) ? '*' : ''}`).join(' · ') + (gap ? ` (* NSE ${esc(s.next.find((n) => n.calendarNote)?.calendarNote || 'holiday list not yet published')}${s.calendar?.coveredUntil ? ` after ${esc(s.calendar.coveredUntil)}` : ''}: may move)` : '');
}
function xpBig(s) {
  return `<div class="xpBox ${s.level === 'expiry' ? 'expiry' : 'eve'}"><b style="color:${s.level === 'expiry' ? 'var(--down)' : 'var(--warn)'}">${s.level === 'expiry' ? '🔴' : '🟠'} ${esc(s.title)}.</b> <b>${esc(s.advice)}</b>
    <ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="note" style="margin:4px 0 0">Next expiries: ${xpNext(s)}. <a href="#" data-goto="researchCard">Research summary</a> · ${esc(s.note)}</div></div>`;
}
function xpSmall(s) {
  return `<div class="xpBox info">⚠ Next expiries: ${xpNext(s)}. Buying options on expiry day or the day before lost in every version the app tested. <a href="#" data-goto="researchCard">Research summary</a> · Not advice.</div>`;
}
const XP_PHONE = window.matchMedia('(max-width: 639.98px)');
/** The one-line summary used on phones (banner summary and the in-card chip). */
function xpLine(s) {
  if (s.level === 'expiry') return `🔴 ${esc(s.short || s.title)} — don't buy options`;
  if (s.level === 'eve') return `🟠 ${esc(s.short || s.title)} — don't buy options today`;
  const n = s.next?.find((x) => x.index === 'NIFTY');
  return `⚠ Next expiry: ${n ? `NIFTY ${esc(xpDay(n.weekly || n.monthly))}` : xpNext(s)}`;
}
XP_PHONE.addEventListener?.('change', () => xpRender());
function xpRender() {
  const s = XP;
  const el = $('expiryBanner');
  if (!s || !el) return;
  const v = XP_VIEW;
  const show = s.level !== 'none' ? ['home', 'options', 'foplan'].includes(v) : ['options', 'foplan'].includes(v);
  el.hidden = !show;
  const fo = s.fo && ['options', 'foplan'].includes(v) ? `<div class="xpBox info" style="margin-top:6px">💰 ${esc(s.fo)} Not advice.</div>` : '';
  const full = (s.level !== 'none' ? xpBig(s) : xpSmall(s)) + fo;
  // phones (< 640 px): one line with a details toggle; desktop unchanged (round 79, owner decision)
  el.innerHTML = !show ? '' : XP_PHONE.matches ? `<details class="xpMini ${s.level === 'expiry' ? 'expiry' : s.level === 'eve' ? 'eve' : 'info'}"><summary>${xpLine(s)}</summary>${full}</details>` : full;
  for (const id of XP_CARDS) {
    const sec = $(id);
    if (!sec) continue;
    let box = sec.querySelector(':scope > .xpCard');
    if (!box) {
      box = document.createElement('div');
      box.className = 'xpCard';
      sec.querySelector(':scope > h2')?.after(box);
    }
    box.innerHTML = XP_PHONE.matches
      ? `<span class="xpChip ${s.level === 'expiry' ? 'expiry' : s.level === 'eve' ? 'eve' : 'info'}">${xpLine(s)}</span>`
      : s.level !== 'none' ? `<div class="xpBox ${s.level === 'expiry' ? 'expiry' : 'eve'}"><b>⚠ ${esc(s.title)}.</b> ${esc(s.advice)} ${esc(s.lines[0])} <a href="#" data-goto="researchCard">Why</a> · Not advice.</div>` : xpSmall(s);
  }
}
async function expiryShow(view) {
  XP_VIEW = view;
  if (XP && Date.now() - XP_AT < 10 * 60_000) return xpRender();
  try {
    XP = await api('/api/expiry');
    XP_AT = Date.now();
  } catch {
    return; // the banner is a caution; the page works without it
  }
  xpRender();
}
expiryShow(document.querySelector('#viewTabs button.active')?.dataset.view || 'home');
