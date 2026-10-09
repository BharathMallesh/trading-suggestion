#!/bin/bash
# Launcher used by the macOS LaunchAgents (scripts/install-autostart.sh).
#   scripts/run.sh server     – dashboard on http://127.0.0.1:3000 (kept alive by launchd)
#   scripts/run.sh collect    – save today's intraday bars
#   scripts/run.sh monitor    – investor monitor (+ macOS notifications)
#   scripts/run.sh refit      – weekly model refit
#   scripts/run.sh backup     – daily backup of the evidence (~/trading-research-backups + iCloud copy)
# Secrets come from the macOS Keychain (encrypted), never from files:
#   security add-generic-password -U -a "$USER" -s trading-research-openrouter -w   # prompts for the key
#   security add-generic-password -U -a "$USER" -s trading-research-groww -w        # optional
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

key() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null; }

case "${1:-}" in
  server)
    OPENROUTER_API_KEY="$(key trading-research-openrouter)"
    GROWW_ACCESS_TOKEN="$(key trading-research-groww)"
    [ -n "$OPENROUTER_API_KEY" ] && export OPENROUTER_API_KEY || unset OPENROUTER_API_KEY
    [ -n "$GROWW_ACCESS_TOKEN" ] && export GROWW_ACCESS_TOKEN || unset GROWW_ACCESS_TOKEN
    echo "$(date '+%F %T') starting server (AI key: $([ -n "${OPENROUTER_API_KEY:-}" ] && echo set || echo missing))"
    exec node server.mjs
    ;;
  collect)
    echo "$(date '+%F %T') collect"; exec node paper-bot/collector.mjs ;;
  monitor)
    # Weekdays only, and only if the server is up.
    if ! curl -s -o /dev/null --max-time 5 http://127.0.0.1:3000/; then
      echo "$(date '+%F %T') monitor skipped: server not running"
      osascript -e 'display notification "Dashboard server is not running" with title "Trading research monitor"' 2>/dev/null
      exit 1
    fi
    echo "$(date '+%F %T') monitor"; exec node paper-bot/monitor.mjs --notify ;;
  refit)
    echo "$(date '+%F %T') refit"; node paper-bot/evaluate.mjs --interval 1d --save && node paper-bot/evaluate.mjs --interval 60m --save \
      && node paper-bot/evaluate.mjs --interval 15m --save && node paper-bot/evaluate.mjs --interval 5m --save
    # Weekly NIFTY option IV vs VIX from new NSE days (independent of the refits above).
    node paper-bot/vol-premium.mjs --save
    # Re-test the probability improvements (adopted only if they still pass out of sample).
    node paper-bot/prob-improve.mjs ;;
  backup)
    echo "$(date '+%F %T') backup"; node paper-bot/backup.mjs ;;
  *)
    echo "usage: scripts/run.sh server|collect|monitor|refit|backup"; exit 2 ;;
esac
