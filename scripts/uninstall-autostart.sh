#!/bin/bash
# Stop and remove the trading-research LaunchAgents (Keychain entries are kept).
for job in server collect monitor refit backup; do
  launchctl bootout "gui/$(id -u)/com.trading-research.$job" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/com.trading-research.$job.plist"
done
echo "Removed. (Keychain secrets remain; delete with: security delete-generic-password -s trading-research-openrouter)"
