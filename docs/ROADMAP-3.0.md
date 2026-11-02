# Good Boy 3.0 plan: Good Boy Link

3.0 is the engine that lets anything talk to the bot: the Minecraft launcher, Roblox games, and future apps.

## How it works
- **Connections**: on the dashboard, create one per app (e.g. "BoxBoyz Launcher", "Roblox: My Obby"). Each gets its own secret
  key and only the abilities ticked for it. Keys are stored hashed, can be revoked in one click, every call is logged, rate limited.
- **Requests**: apps call the bot over HTTPS with their key (plain web requests, which every language and Roblox can make).
- **Events back**: a live stream for apps that can hold a connection (the launcher), and a "new events since" endpoint for
  Roblox (game servers can only make plain requests, and only to public HTTPS addresses).
- **Reachable from the internet**: through the dashboard's share link (Tailscale Funnel) or your own domain.

## Abilities (each one ticked per connection)
| Ability | Example |
|---|---|
| Link accounts | The game/launcher shows a short code, the player types `/link CODE` in Discord: game account tied to Discord, verified |
| Read | A player's Discord level, coins, roles |
| Reward | Coins or XP for playing, winning, daily logins |
| Announce | "Basic beat the boss!" in a chosen channel (never pings @everyone) |
| Roles | Discord role for a game rank or achievement, and the other way round (never staff roles) |
| Live events | Who's online, level-ups, jackpots, server news |

## Ships with
- The engine, `/link`, a Connections page on the dashboard, and a guide with copy-paste examples.
- Ready-made code: a Luau module for Roblox, a Rust library for the launcher, and JavaScript.

## Open questions
- Launcher language (Rust?)
- What the first Roblox game and the launcher do with Discord first.
