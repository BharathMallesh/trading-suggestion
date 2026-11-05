// Calendar study (library): does the time of year, the weekday, a market holiday or the part of the month matter?
// Uses NSE's own trading days (the daily bhavcopy files, 2008 →), so holidays are exact: a weekday with no NSE file
// was a market holiday. For NIFTY and the average NSE top-200 stock (point in time, equal weight):
//   month of the year (monthly returns), weekday, the day before / after a market holiday, each trading day from the
//   last 5 of a month to the first 5 of the next, and start (days 1–5) / middle (6–15) / end (16 → last) of the month.
// Each answer for 2008–16 and 2017 → separately; "consistent" = same direction with |t| ≥ 2 in both halves. Also the
// same cuts for any strategy's trades (by the trade's date). Research only.

export const SPLIT = '2017-01-01';
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const PHASES = ['start (days 1–5)', 'middle (days 6–15)', 'end (day 16 → last)'];
export const HOLIDAY = ['day before a holiday', 'day after a holiday', 'other days'];
export const TURN = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]; // −1 = the month's last trading day, +1 = the first
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const isWeekday = (d) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w >= 1 && w <= 5;
};

/** n, share of positive values, average, t-statistic. */
export function stats(v) {
  const n = v.length;
  if (!n) return { n: 0 };
  const m = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
  return { n, win: v.filter((x) => x > 0).length / n, avg: m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : null };
}

/**
 * The trading calendar from a sorted list of trading dates: for each date its weekday, month, trading-day number in
 * the month from the start and from the end, the part of the month, and whether a market holiday (a weekday with no
 * trading) comes right after it or right before it.
 */
export function buildCalendar(dates) {
  const ds = [...new Set(dates)].filter(isWeekday).sort();
  const open = new Set(ds);
  const byMonth = new Map();
  for (const d of ds) {
    const m = d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(d);
  }
  const first = ds[0];
  const last = ds.at(-1);
  const info = new Map();
  for (const list of byMonth.values()) {
    list.forEach((d, i) => {
      const fromStart = i + 1;
      const fromEnd = i - list.length; // −1 = last
      // the next / previous weekday: closed (a holiday) when it is inside the data range but has no trading
      let n = Date.parse(`${d}T00:00:00Z`) + DAY;
      while (!isWeekday(iso(n))) n += DAY;
      let p = Date.parse(`${d}T00:00:00Z`) - DAY;
      while (!isWeekday(iso(p))) p -= DAY;
      const pre = iso(n) <= last && !open.has(iso(n));
      const post = iso(p) >= first && !open.has(iso(p));
      info.set(d, {
        weekday: WD[new Date(`${d}T00:00:00Z`).getUTCDay()], month: MONTHS[Number(d.slice(5, 7)) - 1], fromStart, fromEnd,
        phase: fromStart <= 5 ? PHASES[0] : fromStart <= 15 ? PHASES[1] : PHASES[2],
        holiday: pre ? HOLIDAY[0] : post ? HOLIDAY[1] : HOLIDAY[2],
        turn: fromEnd >= -5 ? fromEnd : fromStart <= 5 ? fromStart : null,
      });
    });
  }
  return { dates: ds, info, months: byMonth };
}

const split = (rows) => ({ all: stats(rows.map((r) => r.v)), early: stats(rows.filter((r) => r.d < SPLIT).map((r) => r.v)), late: stats(rows.filter((r) => r.d >= SPLIT).map((r) => r.v)) });
const tag = (x) => ({ ...x, consistent: !!(x.early.n && x.late.n && Math.sign(x.early.avg) === Math.sign(x.late.avg) && Math.abs(x.early.t ?? 0) >= 2 && Math.abs(x.late.t ?? 0) >= 2) });
function group(rows, keyOf, keys) {
  const g = new Map(keys.map((k) => [k, []]));
  for (const r of rows) {
    const k = keyOf(r);
    if (k != null && g.has(k)) g.get(k).push(r);
  }
  return Object.fromEntries([...g].map(([k, v]) => [k, tag(split(v))]));
}

/** Calendar cuts of dated values ({ d, v }): weekday, month, part of month, holiday, turn of the month. */
export function cuts(rows, cal) {
  const known = rows.filter((r) => cal.info.has(r.d));
  const at = (r) => cal.info.get(r.d);
  return {
    all: tag(split(known)),
    weekday: group(known, (r) => at(r).weekday, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']),
    month: group(known, (r) => at(r).month, MONTHS),
    phase: group(known, (r) => at(r).phase, PHASES),
    holiday: group(known, (r) => at(r).holiday, HOLIDAY),
    turn: group(known, (r) => at(r).turn, TURN),
  };
}

/** Monthly returns (%) of a daily close series: last close of each month vs the last close of the month before. */
export function monthlyReturns(closes) {
  const last = new Map();
  for (const x of closes) last.set(x.date.slice(0, 7), x);
  const ms = [...last.keys()].sort();
  const out = [];
  for (let i = 1; i < ms.length; i++) out.push({ d: last.get(ms[i]).date, month: MONTHS[Number(ms[i].slice(5, 7)) - 1], v: (last.get(ms[i]).close / last.get(ms[i - 1]).close - 1) * 100 });
  return out;
}

/**
 * A turn-of-the-month rule for NIFTY: buy at the close 3 trading days before the month ends, sell at the close of
 * the 2nd trading day of the next month (4 days in the market), money in a liquid fund (6% a year) the rest of the
 * time; `cost` = round trip (0.25% assumed for a NIFTY ETF with spread). Against simply holding NIFTY.
 */
export function turnOfMonthRule(nifty, cal, { cost = 0.0025, cashYield = 0.06 } = {}) {
  const idx = new Map(nifty.map((x, i) => [x.date, i]));
  const months = [...cal.months.keys()].sort();
  const trades = [];
  for (let k = 0; k + 1 < months.length; k++) {
    const cur = cal.months.get(months[k]);
    const nxt = cal.months.get(months[k + 1]);
    if (cur.length < 3 || nxt.length < 2) continue;
    const ia = idx.get(cur[cur.length - 3]);
    const ib = idx.get(nxt[1]);
    if (ia == null || ib == null) continue;
    trades.push({ d: nxt[1], r: nifty[ib].close / nifty[ia].close - 1, days: ib - ia });
  }
  const run = (xs, from, to) => {
    if (!xs.length) return null;
    const years = (Date.parse(to) - Date.parse(from)) / 31557600000;
    const g = xs.reduce((a, x) => a * (1 + x.r - cost), 1);
    const inDays = xs.reduce((a, x) => a + x.days, 0);
    const withCash = g * (1 + cashYield) ** Math.max(0, years - inDays / 248);
    const s = stats(xs.map((x) => x.r * 100));
    const i0 = nifty.findIndex((x) => x.date >= from);
    const i1 = nifty.findLastIndex((x) => x.date <= to);
    return { months: xs.length, avg4day: s.avg, up: xs.filter((x) => x.r > cost).length / xs.length, t: s.t, perYear: withCash ** (1 / years) - 1, buyHoldPerYear: (nifty[i1].close / nifty[i0].close) ** (1 / years) - 1 };
  };
  const end = trades.at(-1)?.d;
  return { cost, cashYield, all: run(trades, cal.dates[0], end), early: run(trades.filter((x) => x.d < SPLIT), cal.dates[0], SPLIT), late: run(trades.filter((x) => x.d >= SPLIT), SPLIT, end) };
}

/**
 * The market study: NIFTY (daily closes) and the average top-200 stock (NSE files), daily % returns cut by the
 * calendar, plus month-of-the-year from monthly returns. `series`: symbol → adjusted NSE rows; `uni`: month → set.
 */
export function marketCalendar({ series, uni, nifty, from = '2008-01-01' }) {
  const dates = new Set();
  for (const rows of series.values()) for (const r of rows) if (r.date >= from) dates.add(r.date);
  const cal = buildCalendar([...dates]);
  // NIFTY daily % (only NSE trading days)
  const n = nifty.filter((x) => x.close > 0 && cal.info.has(x.date));
  const niftyDaily = [];
  for (let i = 1; i < n.length; i++) niftyDaily.push({ d: n[i].date, v: (n[i].close / n[i - 1].close - 1) * 100 });
  // the average stock's daily % (top 200 that month; a move over 20% = a corporate action / bad print, left out)
  const sum = new Map();
  for (const [s, rows] of series) {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.date < from || !uni.get(r.date.slice(0, 7))?.has(s) || !(rows[i - 1].close > 0)) continue;
      const v = (r.close / rows[i - 1].close - 1) * 100;
      if (Math.abs(v) > 20) continue;
      const o = sum.get(r.date) || { s: 0, n: 0 };
      o.s += v;
      o.n++;
      sum.set(r.date, o);
    }
  }
  const stockDaily = [...sum].filter(([, o]) => o.n >= 20).map(([d, o]) => ({ d, v: o.s / o.n })).sort((a, b) => a.d.localeCompare(b.d));
  const niftyMonthly = monthlyReturns(n);
  return {
    from: cal.dates[0], to: cal.dates.at(-1), days: cal.dates.length, split: SPLIT,
    holidays: (() => {
      let c = 0;
      for (const v of cal.info.values()) if (v.holiday === HOLIDAY[0]) c++;
      return c;
    })(),
    nifty: { ...cuts(niftyDaily, cal), monthOfYear: group(niftyMonthly, (r) => r.month, MONTHS) },
    turnOfMonth: turnOfMonthRule(n, cal),
    stocks: cuts(stockDaily, cal),
    cal,
  };
}
