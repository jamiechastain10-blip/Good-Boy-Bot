# Replacing other bots with Good Boy

Good Boy 2.3 covers what Carl-bot, YAGPDB, Statbot and TTS Bot do. Medal stays for now (see `docs/ROADMAP-CLIPPER.md`).

## Step by step
1. Update to 2.3.
2. Give Good Boy **View Audit Log** and **Ban Members** (only needed for the scan: auto roles come from the audit log, bans from the ban list).
3. Run **`/migrate scan`**. It looks at what the other bots left in your server and lists it. Nothing changes yet.
4. Pick what to import (or **Import everything**).
5. Paste custom commands with **`/migrate tags`** (a name on its own line, the reply under it, `---` between commands). Copy them from Carl-bot's dashboard (Tags) or YAGPDB's control panel (Custom commands).
6. Run **`/stats backfill`** with days empty, to count your whole message history (instead of Statbot's).
7. Check that everything works for a day, then remove the old bots (right-click the bot → Kick, or Server Settings > Integrations).

## What replaces what
| Old bot | Feature | Good Boy |
|---|---|---|
| Carl-bot | Reaction roles | `/reactionrole`, `/rolemenu` (existing Carl messages are taken over by `/migrate`) |
| Carl-bot | Auto roles | `/autorole` |
| Carl-bot | Logging | moderation: mod log (edits, deletes, cases) + server log (joins, leaves, roles, nicknames, voice) |
| Carl-bot | AutoMod | moderation AutoMod; Discord's own AutoMod rules keep working |
| Carl-bot | Welcome / goodbye | member-management welcome and goodbye |
| Carl-bot | Starboard | engagement `/starboard` |
| Carl-bot | Suggestions | engagement `/suggest` |
| Carl-bot | Tags | tags module: `?name` commands and auto-replies |
| Carl-bot | Embeds | `/say send`, `/say edit` |
| Carl-bot | Reminders | `/remind` |
| YAGPDB | Custom commands | tags module (simple replies; no scripting) |
| YAGPDB | Feeds (Reddit, YouTube) | `/feed` |
| YAGPDB | Role menus | `/rolemenu` |
| YAGPDB | Reputation | `/rep` |
| YAGPDB | Timed messages | `/announce schedule` with repeat |
| Statbot | Stats and leaderboards | `/stats`, Stats page charts, Active members |
| Statbot | Counter channels | `/counter` |
| TTS Bot | Text to speech | `/tts`, the no-mic channel |

## What can't be imported
- Each bot's private settings (they are on that bot's servers).
- Custom commands and tags can't be read from Discord: paste them with `/migrate tags`.
- YAGPDB scripted custom commands (templates with code) become plain replies.
- Statbot's history: `/stats backfill` counts messages again from Discord; voice time from before can't be recovered.
- TTS Bot voice choices: members pick again with `/tts voice`.
