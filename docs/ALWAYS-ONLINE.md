# Keeping Good Boy online all the time

Good Boy runs on the computer you start it on. When that computer sleeps or turns off, the bot goes offline. Big bots
like Dyno and MEE6 never go offline because they run on servers that are always on. You can do the same with a machine
that stays on. Pick one:

| | What it costs | Good for |
|---|---|---|
| **Raspberry Pi 4 or 5** at home (4 GB or more) | A one-off purchase (the board, a power supply and a memory card), then a few watts of electricity | The simplest always-on option if you have one or don't mind buying one |
| **A small cloud server (VPS)** | Usually a few dollars or euros a month for the smallest plan; some providers have a free tier | Never depends on your home internet or power |
| **An old laptop or PC** left on | Free (electricity only) | Fine if you have one spare; turn sleep off |

Good Boy needs very little: 1 GB of memory is enough for a few servers (2 GB if you use music a lot), and any recent
64-bit Linux works. Prices and free tiers change, so check the provider's own page.

## Set it up (Raspberry Pi OS, Ubuntu or Debian)
1. Put the Good Boy folder on the machine (download the release zip and unpack it, or copy the folder over).
2. In that folder run:
   ```
   bash deploy/install-linux.sh
   ```
   It installs Node 22 if needed, the bot's packages, asks for your bot token the first time (it is saved only in
   `.env` on that machine), and adds a **service**: the bot starts when the machine boots and restarts itself if it
   ever crashes. Run it again any time; it only does what is still missing.
3. **Only run one copy.** Stop the bot in the Windows app and untick "Start the bot with the app". Two copies with the
   same token fight each other.

Handy commands afterwards: `journalctl -u goodboy -f` (what it's doing), `sudo systemctl restart goodboy`,
`sudo systemctl stop goodboy`.

## Bring your data from the Windows app
Your levels, coins, fish, tickets and settings live in one database. In the Windows app open **Settings > Data >
Export** to save a `.goodboy` file, copy it into the Good Boy folder on the new machine, and run the install script
(before the bot's first start there). It loads the file. To load one later: stop the service, run
`npm run import-data -- your-file.goodboy`, and start it again.

## Docker instead
If you already use Docker: put your `.env` next to `docker-compose.yml` (run `npm run setup` once, or copy it), then
```
docker compose up -d
```
Data is kept in `./data`. The dashboard is on port 3000 of that machine only.

## The dashboard from anywhere
On a server there is no Windows app to turn the link on. Use one of the options in [HOSTING.md](HOSTING.md) (Tailscale
Funnel or ngrok) on the server, set `DASHBOARD_BASE_URL` in `.env`, and add `<that address>/callback` to your bot's
Redirects in the Discord Developer Portal.

## Updates
`npm run supervised` (what the service runs) installs signed updates by itself when updates are set up (see
[UPDATES.md](UPDATES.md)). Otherwise, download the new release, replace the files (keep `data/` and `.env`), and
`sudo systemctl restart goodboy`.
