#!/bin/bash
# Install macOS LaunchAgents so the app runs on its own:
#   server  – starts at login, restarted automatically if it stops
#   collect – weekdays 16:05 (after the close)
#   monitor – weekdays 10:00, 13:00, 15:00 (macOS notifications for alerts)
#   refit   – Saturdays 10:00
#   backup  – every day 18:30 (~/trading-research-backups, last 30 + iCloud copy)
# Missed runs (Mac asleep) run when it wakes. Logs: ~/Library/Logs/trading-research/
# Remove with scripts/uninstall-autostart.sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/scripts/run.sh"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/trading-research"
mkdir -p "$AGENTS" "$LOGS"
chmod +x "$RUN"

plist() { # label, job, extra-xml
  cat > "$AGENTS/com.trading-research.$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.trading-research.$1</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$RUN</string><string>$2</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StandardOutPath</key><string>$LOGS/$1.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$1.log</string>
$3
</dict></plist>
PLIST
}
cal() { # weekday(1-6) hour minute → one StartCalendarInterval dict
  echo "<dict><key>Weekday</key><integer>$1</integer><key>Hour</key><integer>$2</integer><key>Minute</key><integer>$3</integer></dict>"
}

plist server server "  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>"
C=""; M=""
for d in 1 2 3 4 5; do C="$C$(cal $d 16 5)"; for h in 10 13 15; do M="$M$(cal $d $h 0)"; done; done
plist collect collect "  <key>StartCalendarInterval</key><array>$C</array>"
plist monitor monitor "  <key>StartCalendarInterval</key><array>$M</array>"
plist refit refit "  <key>StartCalendarInterval</key><array>$(cal 6 10 0)</array>"
plist backup backup "  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>30</integer></dict>"

for job in server collect monitor refit backup; do
  launchctl bootout "gui/$(id -u)/com.trading-research.$job" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.trading-research.$job.plist"
done
echo "Installed. Dashboard: http://127.0.0.1:3000  ·  logs: $LOGS"
security find-generic-password -a "$USER" -s trading-research-openrouter >/dev/null 2>&1 \
  && echo "AI key: found in Keychain" \
  || echo "AI key: NOT in Keychain yet — run: security add-generic-password -U -a \"\$USER\" -s trading-research-openrouter -w   (then: launchctl kickstart -k gui/\$(id -u)/com.trading-research.server)"
