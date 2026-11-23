# Good Boy 4 (in development)

The Rust rebuild of Good Boy. This folder is private work in progress: it is left out of public releases
(`.gitattributes` marks it `export-ignore`) until v4 is ready.

## What exists so far

| Part | What it does | State |
|---|---|---|
| `crates/gb-data` | Opens the same `eclipse.db` Good Boy 3 writes, with the same tables and values. Brings a 3.x install's data across by copying it. | Working, tested against data written by the real 3.x code |
| Leaderboards for big servers | The top 10 and a member's place come from an index, tested with 60,000 members. | Working |
| `crates/gb-cli` | The `goodboy` command with no window (for web hosts): first run, `run`, `data check`, `data find`, `data import`. | Working |
| `crates/gb-core` | The bot's rules with no Discord in them: settings held in memory, cards, and eleven modules: levels, money, moderation (warn, timeout, kick, ban, timed bans, purge, history, AutoMod, a server's own strike ladder, server logs), welcome and goodbye messages, role menus, tickets (the core loop), reminders, giveaways, custom commands, counting and word chain, and fun. Permissions follow Good Boy 3's rules. | Working, tested on 3.x data; 3.x reads back what v4 writes |
| `crates/gb-discord` | The connection to Discord (twilight): turns Discord's events into the core's events and carries out its actions. `goodboy run <data folder>`. | Compiles and its conversions are tested. **Not yet run against real Discord** |
| Other modules (music, games, AutoMod and logs, welcome, roles and the rest) | | Not started |
| `crates/gb-host` | What a program hosting the bot needs: folders, first run, the token and client secret in the system's credential store, start/stop, and the desk (everything the launcher's screens can ask for). | Working, tested without a window |
| `crates/gb-launcher` + `launcher/ui` | The launcher (Tauri): boot animation, first run, guided tour, Home, Servers with every setting, Bot settings (token, client secret), the built-in guide. The bot runs inside the same program. Open `launcher/ui/index.html` in a browser to see the screens with pretend data (`?first&old` for the first run). | Runs here and builds for Windows. In-app updates, sign-in and the other modules' pages are not started |
| `launcher/brand` | The Good Boy mascot, refreshed from the original drawing by `refresh.py` (also writes the launcher logo and app icons), and the banner (`banner.html`). | Done |
| Clipper | | Not started |

## Rules this code follows

- **3.x data is only ever read.** Importing copies it. The old version keeps working and going back is always possible.
- **No 3.x table changes shape.** Anything v4 needs on top goes in tables whose names start with `v4_`.
- **Refuse what is not understood.** A database from a newer Good Boy, or a file that is not a Good Boy database, is refused with a plain reason.

## Build and test

```
cd v4
cargo test        # needs Node 22+: the tests make real Good Boy 3 data with the 3.x code
cargo build --release
target/release/goodboy data check <folder with eclipse.db>
```

See `docs/HANDOVER.md` for how every existing Good Boy 3 app gets v4 and keeps its data, and
`docs/SCALE-AND-HOSTING.md` for the big-server and web-hosting requirements.

## Trying the games without Discord

`cargo run --release -p gb-core --example emulator -- 8787`, then open http://localhost:8787. It is a page that looks like a Discord channel and runs the bot's real code: `/fish`, `/slots`, `/blackjack`, `/coinflip`, `/balance` and `/daily`, with the same popups, buttons, dropdowns and pictures the bot sends. Nothing in it talks to Discord, and its data is thrown away when it stops.
