#!/bin/bash
# Launcher used by the macOS LaunchAgents (scripts/install-autostart.sh).
#   scripts/run.sh server     – dashboard on http://127.0.0.1:3000 (kept alive by launchd)
#   scripts/run.sh collect    – save today's intraday bars
#   scripts/run.sh monitor    – investor monitor (+ macOS notifications)
#   scripts/run.sh refit      – weekly model refit
#   scripts/run.sh backup     – daily backup of the evidence (~/trading-research-backups + iCloud copy)
# Secrets come from the macOS Keychain (encrypted), never from files:
#   security add-generic-password -U -a "$USER" -s trading-research-openrouter -w   # prompts for the key
#   security add-generic-password -U -a "$USER" -s trading-research-groww-key -w     # Groww API key (optional)
#   security add-generic-password -U -a "$USER" -s trading-research-groww-secret -w  # Groww API secret (optional)
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

key() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null; }

# After waking from sleep, Wi-Fi can take a while to reconnect: wait up to ~10 minutes
# for Yahoo to answer before downloading (a refit once ran offline and failed every step).
wait_online() {
  for _ in $(seq 1 20); do
    curl -s -o /dev/null --max-time 10 https://query1.finance.yahoo.com/ && return 0
    sleep 30
  done
  echo "Error: no internet connection after 10 minutes (fetch failed)"
  return 1
}

# The evening job (after the close): prices, then every paper record, then the evening note.
do_collect() {
  wait_online; node paper-bot/collector.mjs --notify
  # paper records of all the strategies (after the close)
  node paper-bot/vwap-pullback.mjs --paper
  node paper-bot/ath-swing.mjs --paper --alerts   # also: trailing-stop price alerts for open swing positions
  node paper-bot/swing-orb.mjs   # swing entry timing test: buy at the open vs on the opening-range breakout
  node paper-bot/breakfast.mjs --paper
  node paper-bot/nifty-dip.mjs --paper
  node paper-bot/fo-strangle.mjs --paper   # F&O: NSE files arrive in the evening, so this records up to yesterday
  node --max-old-space-size=4000 paper-bot/spread-paper.mjs   # ₹10,000 practice account: Fits-my-budget spreads (settles / marks; opens only if today's NSE file is out)
  node paper-bot/core-satellite.mjs --update   # the 80/20 index fund + swing paper account
  node --max-old-space-size=8000 paper-bot/rsi-swing.mjs --paper   # RSI swing (Rathod): live scan + paper record
  # Momentum 20: add the day's NSE file, then this month's list + the paper portfolio
  node paper-bot/bhav-history.mjs >/dev/null && node --max-old-space-size=12000 paper-bot/momentum.mjs --paper
  # Momentum 10 + buffer (candidate): this month's list + its paper portfolio
  node --max-old-space-size=12000 paper-bot/momentum10.mjs --paper
  # Up/Down outlook: today's Strong / Neutral / Weak labels + the weekly scorecard
  node --max-old-space-size=12000 paper-bot/updown-outlook.mjs
  # Steady mix: 30% Momentum 10 (with the NIFTY filter) / 10% gold / 60% liquid paper portfolio (uses the list above)
  node paper-bot/steady-mix.mjs --paper
  # India mix: ⅓ Nifty Next 50 / ⅓ gold / ⅓ Momentum 10 paper portfolio (uses the Momentum 10 list above)
  node paper-bot/india-mix.mjs --paper
  # Imbalance swing: paper record + scan from the NSE daily files added above
  node --max-old-space-size=12000 paper-bot/imbalance-swing.mjs --paper
  # one evening notification for all strategies + this week's scorecard refreshed
  node paper-bot/evening.mjs --notify
}

# The weekly re-tests (Saturday 10:00).
do_refit() {
  wait_online; node paper-bot/evaluate.mjs --interval 1d --save && node paper-bot/evaluate.mjs --interval 60m --save \
    && node paper-bot/evaluate.mjs --interval 15m --save && node paper-bot/evaluate.mjs --interval 5m --save
  # F&O stock spreads on real NSE option prices (new months only; shown in My F&O plan)
  node --max-old-space-size=12000 paper-bot/fo-stock-backtest.mjs 2>/dev/null
  # Weekly NIFTY option IV vs VIX from new NSE days (independent of the refits above).
  node paper-bot/vol-premium.mjs --save
  # Re-test the probability improvements (adopted only if they still pass out of sample).
  node paper-bot/prob-improve.mjs
  # Re-run the VWAP strategy improvement test on the (growing) saved 5-minute history.
  node paper-bot/vwap-pullback.mjs --improve >/dev/null
  # Re-test the per-signal odds (shown adjusted only if they beat the plain win rate out of sample)
  node paper-bot/vwap-odds.mjs >/dev/null
  # NSE holiday list (exchange calendar for health checks, alerts and market-open status)
  node paper-bot/market-calendar.mjs --refresh >/dev/null
  # Factor lab: NSE momentum / quality / low-vol / value indices vs NIFTY (adds each new month-end)
  node paper-bot/factor-lab.mjs >/dev/null
  # "Analyse today": how often trends kept going, by time of day and alignment
  node paper-bot/today-scan.mjs >/dev/null
  # strong-stock swing strategy: re-run the backtest on the newest data
  node paper-bot/ath-swing.mjs >/dev/null
  # survivorship-free check: add the week's NSE daily files, re-run on the point-in-time top 200
  node paper-bot/bhav-history.mjs >/dev/null && node paper-bot/ath-swing.mjs --survivorship >/dev/null
  # breakfast strategy: re-run on the growing 5-minute history
  node paper-bot/breakfast.mjs >/dev/null
  # NIFTY dip-buy: re-run the backtest with the week's closes
  node paper-bot/nifty-dip.mjs >/dev/null
  # NIFTY weekly short strangle: re-run on the cached NSE option weeks
  node paper-bot/fo-strangle.mjs >/dev/null
  # F&O spreads (specification document): backtests + the real-NSE-price check
  node paper-bot/fno-spreads.mjs >/dev/null
  # RSI swing (Rathod): re-run on the last two years of hourly candles
  node --max-old-space-size=8000 paper-bot/rsi-swing.mjs >/dev/null
  # Momentum 20: re-run the survivorship-free backtest (also refreshes NSE's ETF list)
  node --max-old-space-size=12000 paper-bot/momentum.mjs >/dev/null
  # New ideas: low volatility, momentum + low volatility, momentum with a market filter
  node --max-old-space-size=12000 paper-bot/new-ideas.mjs >/dev/null
  # Momentum 10 + buffer (candidate): re-run its backtest
  node --max-old-space-size=12000 paper-bot/momentum10.mjs >/dev/null
  # Steady mix: re-run its backtest
  node --max-old-space-size=12000 paper-bot/steady-mix.mjs >/dev/null
  # India mix: re-run its backtest
  node --max-old-space-size=12000 paper-bot/india-mix.mjs >/dev/null
  # Option strike guide: ITM / ATM / OTM weekly buys on the cached NSE option files
  node paper-bot/option-strikes.mjs >/dev/null
  # Up/Down outlook: rebuild the odds tables (16 years, by label)
  node --max-old-space-size=12000 paper-bot/updown-outlook.mjs --table >/dev/null
  # Imbalance swing: re-run the 16-year backtest
  node --max-old-space-size=12000 paper-bot/imbalance-swing.mjs >/dev/null
  # Matrix calendar: adds the new weeks' NSE option files (cached) and re-runs the test
  node paper-bot/matrix-calendar.mjs >/dev/null
  # Day patterns: every strategy by weekday / opening gap, and the Monday tests (~2 minutes)
  # Groww 5-minute history since 2020 (new days only, ~2 min; needs the Groww Trading API) and the intraday strategies on it
  GROWW_API_KEY="$(key trading-research-groww-key)" GROWW_API_SECRET="$(key trading-research-groww-secret)" node --max-old-space-size=4000 paper-bot/groww-history.mjs >/dev/null 2>&1 \
    && node --max-old-space-size=14000 paper-bot/intraday-5y.mjs >/dev/null \
    && GROWW_API_KEY="$(key trading-research-groww-key)" GROWW_API_SECRET="$(key trading-research-groww-secret)" node --max-old-space-size=8000 paper-bot/fo-intraday-backtest.mjs >/dev/null 2>&1
  node --max-old-space-size=14000 paper-bot/day-patterns.mjs >/dev/null
}

# One job at a time: the scheduled runs and the catch-up share a lock (a stale one,
# older than 3 hours, is removed).
LOGS="$HOME/Library/Logs/trading-research"
LOCK="$LOGS/.run.lock"
take_lock() {
  mkdir -p "$LOGS"
  if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; fi
  mkdir "$LOCK" 2>/dev/null || return 1
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
}

# Automatic catch-up (from the 18:30 backup and the weekday monitor): if the last
# evening run did not save the day's prices / paper records, or the weekly refit
# failed, run it again now. A notification comes only if it still fails.
catchup() {
  need="$(node paper-bot/watchdog.mjs --needs 2>/dev/null)"
  [ -z "$need" ] && return 0
  take_lock || { echo "catch-up skipped: another run is in progress"; return 0; }
  case "$need" in *collect*)
    echo "$(date '+%F %T') catch-up: re-running the evening job"
    { echo "$(date '+%F %T') collect (catch-up)"; do_collect; node paper-bot/watchdog.mjs --notify; } >> "$LOGS/collect.log" 2>&1 ;;
  esac
  case "$need" in *refit*)
    echo "$(date '+%F %T') catch-up: re-running the weekly refit"
    { echo "$(date '+%F %T') refit (catch-up)"; do_refit; } >> "$LOGS/refit.log" 2>&1 ;;
  esac
}

case "${1:-}" in
  server)
    OPENROUTER_API_KEY="$(key trading-research-openrouter)"
    GROWW_ACCESS_TOKEN="$(key trading-research-groww)"
    GROWW_API_KEY="$(key trading-research-groww-key)"
    GROWW_API_SECRET="$(key trading-research-groww-secret)"
    [ -n "$GROWW_API_KEY" ] && [ -n "$GROWW_API_SECRET" ] && export GROWW_API_KEY GROWW_API_SECRET || unset GROWW_API_KEY GROWW_API_SECRET
    [ -n "$OPENROUTER_API_KEY" ] && export OPENROUTER_API_KEY || unset OPENROUTER_API_KEY
    [ -n "$GROWW_ACCESS_TOKEN" ] && export GROWW_ACCESS_TOKEN || unset GROWW_ACCESS_TOKEN
    echo "$(date '+%F %T') starting server (AI key: $([ -n "${OPENROUTER_API_KEY:-}" ] && echo set || echo missing))"
    exec node server.mjs
    ;;
  collect)
    caffeinate -i -w $$ & # keep the Mac awake until this job finishes
    take_lock || { echo "$(date '+%F %T') collect skipped: another run is in progress"; exit 0; }
    echo "$(date '+%F %T') collect"; do_collect
    node paper-bot/watchdog.mjs --notify ;;
  monitor)
    # Weekdays only, and only if the server is up.
    if ! curl -s -o /dev/null --max-time 5 http://127.0.0.1:3000/; then
      echo "$(date '+%F %T') monitor skipped: server not running"
      osascript -e 'display notification "Dashboard server is not running" with title "Trading research monitor"' 2>/dev/null
      exit 1
    fi
    echo "$(date '+%F %T') monitor"; node paper-bot/monitor.mjs --notify
    # a missed evening run / refit is caught up here (no-op when everything is fine)
    caffeinate -i -w $$ &
    catchup ;;
  refit)
    caffeinate -i -w $$ & # keep the Mac awake until this job finishes
    take_lock || { echo "$(date '+%F %T') refit skipped: another run is in progress"; exit 0; }
    echo "$(date '+%F %T') refit"; do_refit ;;
  backup)
    caffeinate -i -w $$ & # keep the Mac awake until this job finishes
    echo "$(date '+%F %T') backup"; node paper-bot/backup.mjs
    # spread paper again once NSE's evening F&O file is out (it opens trades only on the day's own closing prices):
    # NSE often publishes it late, so try every 15 minutes until about 21:30
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13; do
      node --max-old-space-size=4000 paper-bot/spread-paper.mjs
      node -e "import('./paper-bot/market-calendar.mjs').then((m) => { const d = m.lastSessionDate(); process.exit(require('node:fs').existsSync('paper-bot/data/fo-stocks/' + d + '.json') ? 0 : 1); })" && break
      sleep 900
    done
    # catch up a failed evening run / weekly refit, then the watchdog with the fresh backup
    catchup
    node paper-bot/watchdog.mjs --notify ;;
  *)
    echo "usage: scripts/run.sh server|collect|monitor|refit|backup"; exit 2 ;;
esac
