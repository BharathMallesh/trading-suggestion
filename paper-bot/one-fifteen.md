# 1:15 PM reversal — pre-registered test (written 20 Nov 2026, before any result was computed)

Source: "The 1:15 PM Trading Strategy", Rajesh Jain / Upsurge Club, YouTube `_ux9Lre4voo` (31 Oct 2026). The video gives
no numbers. Everything below is fixed BEFORE the backtest is run; nothing is tuned afterwards. Paper / research only —
not advice.

## Definitions (all versions)

- Data: Groww 5-minute bars 2020-01-01 → 2026-11-04 (`paper-bot/data/candles-hist`, `cleanBars`), extended with the live
  5-minute store (`paper-bot/data/candles/5m`) for later days. Bars 09:15–15:25 only. 200 stocks (today's lists — slight
  survivorship flattery) + NIFTY. BANKNIFTY has no 5-minute history in the store, so the index test is NIFTY only.
- Previous close = close of the previous session's last 5-minute bar (NSE's official close is a 15:00–15:30 average; the
  difference is small).
- Move = price at 13:15 (close of the 13:10 bar) ÷ previous close − 1.
- Qualifying stock: |move| ≥ 3% (main) — variant |move| ≥ 5% ("strong day" reading). |move| > 20% is skipped (that is a
  split/bonus in the unadjusted data, not a move).
- The 1:15 candle = the 30-minute candle 13:15–13:45 = the six 5-minute bars 13:15 … 13:40. Level high H, low L.
- Direction (REVERSAL, as in the video): move up → SHORT when price trades below L, stop = H. Move down → LONG when price
  trades above H, stop = L. A break the other way is ignored (does not cancel the level).
- Entry: the first 5-minute bar from 13:45 on whose low < L (short) / high > H (long); filled at the level, or at the
  bar's open if the bar opens beyond the level (gap through: the worse price), plus slippage.
- Risk = |fill − stop|. Skip the trade if risk < 0.3% or > 3% of the fill price (index: < 0.1% or > 3%, since NIFTY's
  30-minute ranges are ~3× smaller than a stock's).
- Target = 1R from the fill.
- Inside a bar: if stop and target are both inside one bar the stop counts first; on the entry bar only the stop is
  checked (its high/low may have come before the fill). A bar opening beyond the stop / target fills at the open.
- Sizing: ₹1,000 risk per trade (qty = ₹1,000 ÷ risk per share, capped at ₹1 lakh × 5 leverage), like the VWAP tests.
- Account: max 2 NEW trades per day across all stocks (earliest entry first; ties → bigger |move|), 1 per stock per day,
  no new trade in a stock while a trade in it is open. The uncapped "every signal" result is reported too.

## Versions (fixed in advance)

- **V — video**: day-1 entries 13:45 → before 15:15. If the target is hit the same day → out. If neither stop nor target
  is hit by the close (15:25 bar close) → CARRY overnight; next day exit at target / stop / 15:15 (open of the 15:15 bar).
  Shorts can't be carried in cash, so carried trades are stock futures (F&O stocks only — today's NSE F&O list; non-F&O
  stocks exit at 15:15 on day 1). If the level is NOT triggered on day 1 it stays valid on the next session from 09:15
  until 15:15 (an intraday trade, exit by 15:15 that day); after that it expires (the video's "works for 3 days" is not
  tested beyond 1 extra day).
- **S — same-day only**: day-1 entries 13:45 → before 15:15, exit at stop / target / 15:15. No carry, no next-day levels.
- **I — index (NIFTY)**: rules of V on the NIFTY 5-minute index as a futures proxy (no basis, no roll), futures charges.
  Threshold |move| ≥ 1% (main; index moves are ~3× smaller) and ≥ 3% (literal). BANKNIFTY: not available.

## Costs

- Same-day trades: NSE intraday equity charges (`costs.mjs`: brokerage min ₹20 / 0.03%, STT 0.025% sell, exchange, SEBI,
  stamp 0.003% buy, GST 18%) + 0.03% slippage per fill (as in vwap-pullback / intraday-5y).
- Carried trades (V, F&O stocks): stock-futures charges (added to `costs.mjs`: brokerage min ₹20 / 0.03%, STT 0.0125% sell
  before 1 Oct 2024, 0.02% after, exchange 0.00173%, SEBI, stamp 0.002% buy, GST 18%) + 0.03% slippage per fill. Real
  futures come in lots (₹1,000 risk is usually less than one lot), ignored; basis/roll ignored.
- NIFTY: futures charges + 0.01% slippage per fill.
- Options (the video's instrument: ATM or ≤ 2 strikes OTM) can NOT be tested reliably — there are no per-stock intraday
  option prices in the data. The underlying's R is the honest proxy; an option adds premium decay (time value lost over
  the overnight carry), bid-ask spreads of 0.5–2% on stock options, and delta < 1.

## Periods and statistics

- Build 2020–22 · check 2023–24 · test 2025 → latest. All reported; none used for choosing anything.
- Trades, win rate, avg R before and after costs, ₹ total, day-clustered t (₹ net summed per entry day), total without the
  best 10 trades, by year, long vs short, |move| ≥ 3% vs ≥ 5%, exits (target / stop / 15:15 / carried).

## Controls (same days, same exits)

- **Trend continuation**: same qualifying stocks and 1:15 candle, trade the break in the trend direction (after an up-move
  buy above H, stop L; after a down-move short below L, stop H).
- **Fade at 13:45 (no level)**: enter every qualifying stock at the 13:45 bar open in the reversal direction, stop =
  entry ± the 1:15 candle's range, target 1R, same exits / filters / account cap. Shows whether waiting for the level adds
  anything over simply fading the move.
- **Random direction at 13:45**: as above but long/short by a seeded coin flip.

## Pass rule (fixed now)

The 1:15 reversal "works" only if, for version V or S on the main ≥ 3% list, after costs:
1. avg R > 0 in each of build, check and test;
2. day-clustered t ≥ 2 on check + test combined (2023 → latest);
3. total ₹ without the best 10 trades > 0;
4. better net R than the fade-at-13:45 control in at least 2 of the 3 periods.
Otherwise it is labelled "does not work after costs" (or "positive but not reliable"). Forward paper record either way.
