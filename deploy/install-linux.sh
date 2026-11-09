#!/usr/bin/env bash
# Basic Ghost Labs - Good Boy
# Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
#
# Keeps Good Boy online all the time on a Raspberry Pi or a Linux server (Ubuntu, Debian, Raspberry Pi OS).
# Run it from the Good Boy folder:   bash deploy/install-linux.sh
# It installs Node 22 if needed, the bot's packages, and a system service that starts the bot when the machine
# boots and restarts it if it ever crashes. Run it again any time; it only does what's still missing.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
RUN_AS="${SUDO_USER:-$(id -un)}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
need_root() { if [ "$(id -u)" -ne 0 ]; then sudo "$@"; else "$@"; fi; }

[ -f package.json ] && grep -q '"good-boy"' package.json || { echo "Run this from the Good Boy folder (the one with package.json)."; exit 1; }

say "1/5 Node.js"
if command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node $(node -v) is fine."
else
  echo "Installing Node 22 (from NodeSource, the usual place for Node on Debian/Ubuntu)..."
  need_root apt-get update -y
  need_root apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | need_root bash -
  need_root apt-get install -y nodejs
fi

say "2/5 The bot's packages"
if [ "$(id -u)" -eq 0 ] && [ "$RUN_AS" != "root" ]; then sudo -u "$RUN_AS" npm install --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi

say "3/5 Settings (.env)"
if [ -f .env ] && grep -q '^DISCORD_TOKEN=.\+' .env; then
  echo ".env is there."
else
  echo "No bot token yet. Answer the questions (your token is only saved in .env on this machine):"
  if [ "$(id -u)" -eq 0 ] && [ "$RUN_AS" != "root" ]; then sudo -u "$RUN_AS" npm run setup; else npm run setup; fi
fi
chmod 600 .env 2>/dev/null || true

say "4/5 Your data (optional)"
if ls ./*.goodboy >/dev/null 2>&1 && [ ! -f data/eclipse.db ]; then
  F="$(ls -t ./*.goodboy | head -1)"
  echo "Loading $F (exported from the Windows app)..."
  node scripts/app-tools.js import "$F" data
else
  echo "Skipped. To bring your data from the Windows app: Settings > Data > Export, copy the .goodboy file into this folder, and run this script again before the bot first starts."
fi

say "5/5 The service (starts at boot, restarts after a crash)"
if command -v systemctl >/dev/null; then
  sed -e "s#__DIR__#${DIR}#g" -e "s#__USER__#${RUN_AS}#g" -e "s#__NODE__#$(command -v node)#g" deploy/goodboy.service | need_root tee /etc/systemd/system/goodboy.service >/dev/null
  need_root systemctl daemon-reload
  need_root systemctl enable --now goodboy
  sleep 3
  need_root systemctl --no-pager --lines=5 status goodboy || true
  say "Done! Good Boy runs all the time now."
  echo "  See what it's doing:  journalctl -u goodboy -f"
  echo "  Restart it:           sudo systemctl restart goodboy"
  echo "  Stop it:              sudo systemctl stop goodboy"
  echo "Only run ONE copy of the bot: stop it in the Windows app (and untick 'Start the bot with the app')."
else
  echo "This system has no systemd. Start the bot with: npm run supervised"
fi
