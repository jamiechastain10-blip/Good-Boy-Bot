# Good Boy 4 on a Linux server

The server version of Good Boy 4: the same bot as the Windows app, with the same dashboard served on the web, so you
(and the people you let in) can manage it from a browser or phone. It is one small program (`goodboy`, about 25 MB,
written in Rust) that runs as a systemd service.

## Put it on a server

You need a Linux server with systemd (Ubuntu 22.04 or newer, Debian 12, Raspberry Pi OS 64-bit), on an x86_64 or ARM64
processor.

```sh
curl -fsSLO https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/download/linux-test/Good-Boy-4-linux-x86_64.tar.gz
tar -xzf Good-Boy-4-linux-x86_64.tar.gz && cd Good-Boy-4-linux
sudo bash install.sh --web https://bot.example.com
```

It asks for the bot token (and, for the dashboard's sign-in, the client secret), then starts the bot. Run it again with
another `--name` for a second bot on the same server. Each bot gets:

| What | Where |
| --- | --- |
| Settings | `/etc/goodboy/<name>.env` |
| Token and client secret | `/etc/goodboy/credentials/<name>/` (root only; systemd hands them to that bot alone) |
| Data (the same `eclipse.db` as on Windows) | `/var/lib/goodboy/<name>/` |
| Logs | `journalctl -u goodboy4@<name>` |

Each bot runs as its own throwaway user that can read nothing but its own data, with limits on memory and processor
(change them with `sudo systemctl edit goodboy4@<name>`).

## The web dashboard

The dashboard listens on this machine only (`GOODBOY_WEB_BIND=local`). Put a web server with https in front of it; with
[Caddy](https://caddyserver.com) that is three lines (see `Caddyfile.example`). Then add `https://<your address>/auth/callback`
under OAuth2 > Redirects in the Discord Developer Portal.

Who can come in:

- **The owner** (whoever owns the bot in the Discord Developer Portal, plus anyone in `GOODBOY_OWNER_IDS`): everything
  except tokens and secrets, which are never shown or taken over the web.
- **People with Manage Server** in a server the bot is in: that server only.
- **People the owner lets in** on the Access page: the servers the owner picks, even without Manage Server. They cannot
  start or stop the bot or change who comes in.
- **Ticket staff**: the Tickets page of their server.
- **Basic Ghost Labs support**, only on bots Basic Ghost Labs hosts (below).

The Access page also has the **access log**: every sign-in and every change made on the dashboard, with who did it.
It records what kind of thing was done and in which server, never what was typed.

## Bots Basic Ghost Labs hosts

A hosted bot has two more settings, which the hosting setup writes:

- `GOODBOY_HOSTED_ID`: the hosting subscription it belongs to.
- `GOODBOY_MAINTAIN_KEY`: the public key of the Basic Ghost Labs site.

When something needs fixing, a support team member asks the site for a **support pass** for that one bot, with a
reason. The pass is signed by the site, works only on that bot, must be opened within 15 minutes, works once, and the
visit lasts an hour. On a visit, support can see the bot's health and check-up, start, stop and restart it, and check for
updates. They cannot see or change servers, members, messages, tickets or settings, and cannot see the token, client
secret or licence key (nobody can, over the web). The visit, its reason and everything done in it go in the owner's
access log, and the owner can turn support access off on the Access page at any time.

## Commands

```
goodboy serve [data folder]                    run the bot (and the dashboard if GOODBOY_WEB_ADDRESS is set)
goodboy secret set <bot-token|client-secret>   save a secret outside systemd (to GOODBOY_SECRETS_DIR, owner-only)
goodboy data check <folder>                    check a Good Boy database
goodboy --version
```

Settings (`/etc/goodboy/<name>.env`): `GOODBOY_WEB_ADDRESS`, `GOODBOY_WEB_PORT` (default 47890), `GOODBOY_WEB_BIND`
(`local` or `all`), `GOODBOY_OWNER_IDS`, `DISCORD_HELPER_TOKENS` (extra music bots), `GOODBOY_HOSTED_ID`,
`GOODBOY_MAINTAIN_KEY`.

## Moving a bot from Windows

Stop Good Boy on Windows, copy its `eclipse.db` (Settings > Data shows the folder) to `/var/lib/goodboy/<name>/`, then
`sudo systemctl restart goodboy4@<name>`. Only one copy of a bot may run at a time.
