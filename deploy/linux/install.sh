#!/usr/bin/env bash
# Basic Ghost Labs - Good Boy 4 on a Linux server. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
#
# Puts Good Boy 4 on a Linux server (Ubuntu, Debian, Raspberry Pi OS, anything with systemd) as a service that starts
# at boot and restarts by itself. Run it again to add another bot or to update the program.
#
#   sudo bash install.sh                          asks a few questions, then starts a bot called "main"
#   sudo bash install.sh --name ari --web https://ari.example.com
#
# Options (all can be left out; you are asked for what is needed):
#   --name <name>            which bot (letters, digits and dashes). Default: main
#   --web <https link>       the public address of its web dashboard. Leave out for no dashboard.
#   --port <port>            the port the dashboard listens on (this machine only). Default: the next free one from 47890
#   --binary <file>          use this goodboy program instead of downloading it
#   --release <tag>          the release to download from. Default: GOODBOY_RELEASE or linux-test
#   --token-file <file>      read the bot token from a file instead of asking (it is copied, then you can delete it)
#   --client-secret-file <file>   the same for the Discord client secret (needed for the dashboard's sign-in)
#   --hosted-id <id> --maintain-key <key>   only for bots Basic Ghost Labs hosts: lets support visit (see README.md)
#   --no-start               set everything up but do not start it
set -euo pipefail
REPO="jamiechastain10-blip/Good-Boy-Bot"
NAME=main WEB="" PORT="" BINARY="" RELEASE="${GOODBOY_RELEASE:-linux-test}" TOKEN_FILE="" SECRET_FILE="" HOSTED_ID="" MAINTAIN_KEY="" START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2;; --web) WEB="$2"; shift 2;; --port) PORT="$2"; shift 2;; --binary) BINARY="$2"; shift 2;;
    --release) RELEASE="$2"; shift 2;; --token-file) TOKEN_FILE="$2"; shift 2;; --client-secret-file) SECRET_FILE="$2"; shift 2;;
    --hosted-id) HOSTED_ID="$2"; shift 2;; --maintain-key) MAINTAIN_KEY="$2"; shift 2;; --no-start) START=0; shift;;
    -h|--help) sed -n '2,24p' "$0"; exit 0;;
    *) echo "Not an option: $1 (try --help)"; exit 1;;
  esac
done
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run it with sudo: sudo bash $0 $*"; exit 1; }
command -v systemctl >/dev/null || { echo "This needs systemd (most Linux servers have it)."; exit 1; }
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || { echo "The name may only have small letters, digits and dashes."; exit 1; }
if [ -n "$WEB" ]; then [[ "$WEB" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "The web address must be an https link with no path, such as https://bot.example.com"; exit 1; }; fi
HERE="$(cd "$(dirname "$0")" && pwd)"

say "1/5 The program"
case "$(uname -m)" in x86_64|amd64) ARCH=x86_64;; aarch64|arm64) ARCH=aarch64;; *) echo "This processor ($(uname -m)) is not supported yet."; exit 1;; esac
install -d -m 0755 /opt/goodboy
if [ -n "$BINARY" ]; then
  install -m 0755 "$BINARY" /opt/goodboy/goodboy.new
elif [ -x "$HERE/goodboy" ]; then
  install -m 0755 "$HERE/goodboy" /opt/goodboy/goodboy.new
else
  command -v curl >/dev/null || { apt-get update -y && apt-get install -y curl ca-certificates; }
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  FILE="Good-Boy-4-linux-$ARCH.tar.gz"
  echo "Downloading $FILE from the $RELEASE release..."
  curl -fsSL -o "$TMP/$FILE" "https://github.com/$REPO/releases/download/$RELEASE/$FILE"
  curl -fsSL -o "$TMP/$FILE.sha256" "https://github.com/$REPO/releases/download/$RELEASE/$FILE.sha256"
  (cd "$TMP" && sha256sum -c "$FILE.sha256") || { echo "The download does not match its checksum, so it was not used."; exit 1; }
  tar -xzf "$TMP/$FILE" -C "$TMP"
  install -m 0755 "$TMP/goodboy" /opt/goodboy/goodboy.new
fi
mv -f /opt/goodboy/goodboy.new /opt/goodboy/goodboy
/opt/goodboy/goodboy --version >/dev/null 2>&1 || true
echo "Installed /opt/goodboy/goodboy."
if ! command -v ffmpeg >/dev/null; then
  if command -v apt-get >/dev/null; then echo "Installing ffmpeg (for music)..."; apt-get install -y ffmpeg >/dev/null 2>&1 || echo "ffmpeg could not be installed; music will not play until it is."; fi
fi

say "2/5 The service"
install -m 0644 "$HERE/goodboy4@.service" /etc/systemd/system/goodboy4@.service
systemctl daemon-reload

say "3/5 Settings for \"$NAME\""
install -d -m 0755 /etc/goodboy
install -d -m 0700 /etc/goodboy/credentials "/etc/goodboy/credentials/$NAME"
ENV="/etc/goodboy/$NAME.env"
if [ -z "$PORT" ]; then
  PORT=$(sed -n 's/^GOODBOY_WEB_PORT=//p' "$ENV" 2>/dev/null || true)
  if [ -z "$PORT" ]; then
    PORT=47890
    while grep -qs "^GOODBOY_WEB_PORT=$PORT$" /etc/goodboy/*.env || (command -v ss >/dev/null && ss -ltn | grep -q ":$PORT "); do PORT=$((PORT + 1)); done
  fi
fi
if [ -z "$WEB" ] && [ -f "$ENV" ]; then WEB=$(sed -n 's/^GOODBOY_WEB_ADDRESS=//p' "$ENV"); fi
if [ -z "$HOSTED_ID" ] && [ -f "$ENV" ]; then HOSTED_ID=$(sed -n 's/^GOODBOY_HOSTED_ID=//p' "$ENV"); MAINTAIN_KEY=${MAINTAIN_KEY:-$(sed -n 's/^GOODBOY_MAINTAIN_KEY=//p' "$ENV")}; fi
{
  echo "# Good Boy 4 \"$NAME\". Change it, then: sudo systemctl restart goodboy4@$NAME"
  echo "GOODBOY_WEB_PORT=$PORT"
  echo "GOODBOY_WEB_BIND=local"
  [ -n "$WEB" ] && echo "GOODBOY_WEB_ADDRESS=$WEB"
  [ -n "$HOSTED_ID" ] && echo "GOODBOY_HOSTED_ID=$HOSTED_ID"
  [ -n "$MAINTAIN_KEY" ] && echo "GOODBOY_MAINTAIN_KEY=$MAINTAIN_KEY"
  # extra owners (a bot owned by a Discord team): GOODBOY_OWNER_IDS=id1,id2
  grep -s '^GOODBOY_OWNER_IDS=' "$ENV" || true
  grep -s '^DISCORD_HELPER_TOKENS=' "$ENV" || true
} > "$ENV.new"
chmod 0640 "$ENV.new"; mv -f "$ENV.new" "$ENV"
echo "Saved $ENV."

say "4/5 Secrets (kept in /etc/goodboy/credentials/$NAME, readable by root only)"
CRED="/etc/goodboy/credentials/$NAME"
put_secret() { # $1 file name, $2 from file, $3 question, $4 optional
  if [ -n "$2" ]; then install -m 0600 "$2" "$CRED/$1"; echo "Saved $1."; return; fi
  if [ -s "$CRED/$1" ]; then echo "$1 is already saved."; return; fi
  if [ -t 0 ]; then
    read -r -s -p "$3" v; echo
    if [ -n "$v" ]; then (umask 077; printf '%s' "$v" > "$CRED/$1"); echo "Saved $1."; unset v; return; fi
  fi
  if [ "$4" = "optional" ]; then : > "$CRED/$1"; chmod 0600 "$CRED/$1"; echo "No $1 for now."; else echo "The bot needs its token. Run this again with --token-file, or in a terminal."; exit 1; fi
}
put_secret bot-token "$TOKEN_FILE" "Paste the bot token (Discord Developer Portal > your app > Bot > Reset Token). It is not shown: " required
put_secret client-secret "$SECRET_FILE" "Paste the client secret (OAuth2 page) for the dashboard's Discord sign-in, or press Enter to skip: " optional

say "5/5 Start"
if [ "$START" -eq 1 ]; then
  systemctl enable "goodboy4@$NAME" >/dev/null 2>&1
  systemctl restart "goodboy4@$NAME"
  sleep 3
  systemctl --no-pager --lines=5 status "goodboy4@$NAME" || true
else
  echo "Not started (--no-start). Start it with: sudo systemctl enable --now goodboy4@$NAME"
fi
cat <<MSG

Good Boy "$NAME" is set up.
  See what it is doing:   journalctl -u goodboy4@$NAME -f
  Restart / stop:         sudo systemctl restart goodboy4@$NAME   /   sudo systemctl stop goodboy4@$NAME
  Its data:               /var/lib/goodboy/$NAME
MSG
if [ -n "$WEB" ]; then cat <<MSG
  Web dashboard:          $WEB  (listens on 127.0.0.1:$PORT; put https in front, see Caddyfile.example)
  In the Discord Developer Portal, add $WEB/auth/callback under OAuth2 > Redirects.
MSG
fi
