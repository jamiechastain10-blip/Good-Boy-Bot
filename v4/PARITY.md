# Good Boy 4: one-to-one with Good Boy 3

Good Boy 4 is Good Boy 3 rebuilt: the same features, wording, data and behaviour, faster and able to handle more.
Nothing Good Boy 3 does is dropped or simplified. Each line below is a Good Boy 3 behaviour; it is ticked only
when Good Boy 4 does the same thing and a test checks it against Good Boy 3.

Status: ✅ matched and tested · 🟡 partly there · ⬜ not yet

## Core

- ✅ Every command is a popup (v3 `src/autopopup.js`): no typed boxes in Discord; text, tall boxes (reason, message,
  details…), dropdowns for choices and yes/no, number fields with limits, member/role/channel pickers; more than 5
  boxes asked in parts with Continue (kept 15 minutes); v3 wording for mistakes with Try again; owner-locked.
- ✅ v3 popup kinds (`src/modalkit.js`): labels with help text, text, paragraph, channel (by kind), role, roles,
  user, select with default, file uploads; current values shown so saving unchanged keeps them.
- 🟡 Commands that open their own popup in v3 (`ownPopup`): ✅ `/ticket panel`, ✅ `/ticket setup`, ✅ `/warn`, ✅ `/rolemenu create`, ✅ `/greeting`, ✅ `/verify setup`, ✅ `/introduce`, ✅ `/pay`, ✅ `/economy-admin`, ✅ ✅ `/giveaway start`; still to do: `/remind team`, `/eclipseid edit`, `/party create`,
  `/poll create` (engagement), `/tempvoice event`.
- ✅ Command permission is checked before the popup opens (staff commands: warn, timeout, kick, ban, purge, history, automod, logs, say, sticky, economy-admin).
- ✅ Admins can use a module in a channel where it is switched off.

## Levels (community)

- ✅ Rank card picture (v3 `src/rankcard.js`): 760×220, 7 themes, two accents, Discord-only backgrounds, avatar ring
  or initials, same fonts, sizes and positions; text version identical to v3's.
- ✅ Customise button and style popup (`rankstyle`), v3 checks and wording; `card:<id>` data; `rankCards` and
  `cardBackgrounds` settings.
- ✅ Leaderboard types (xp, rep, messages), pages, v3 wording ("Leaderboard · XP", "Page n/m").
- ✅ Live leaderboard (`/liveboard`, one message kept up to date, posted again if deleted), its settings.
- ✅ Reputation (`/rep give|check|view|history|remove|set|reset|reset-all`) with every v3 limit, audit log channel, history table, backup before reset-all.
- ✅ Reaction XP, voice XP (daily cap, muted/deafened rules, AFK skipped), `/xp set|reset|ignore|boost`, `/levels reward`, `/serverstats`, member counter channel, record deleted when a member leaves.
- Differences: `/liveboard setup` does not check the bot's channel permissions first; `/serverstats` is a card, not an embed.

## Tickets (support)

Checked against Good Boy 3's own functions (tests `tickets_rules.rs`) and its behaviour and wording (`more_modules.rs`):
- ✅ Rules (`src/tickets.js`): categories with urgency and descriptions, report required/optional, appeals; the popups
  for each (member picker, "not in the server" box, details, links, appeal fields, uploads on every form); custom
  types; reported-person parsing; watch-log matching and its wording; close form; close kinds; stats; ratings.
- ✅ Tables and records: `support_history`, `support_watch`, `support_archive` (+ search), `ticket:<channel>`,
  `counter`, `stats`, `types`, `rating:<n>`, `lastPurge`.
- ✅ Opening: limit per member, files downloaded straight away and kept (25 MB each, 60 MB total, 10 MB re-posted),
  channel name, topic, permissions, control card and buttons, "Who is involved" card, staff background card,
  evidence post, history, watch-log entry for reports, watch-log flag to staff, the log.
- ✅ Claim/Unclaim, Priority with a required reason (priority log), appeal/application decisions with reason and
  member message, application role, staff Close (outcome buttons for reports, five-field form), owner close with
  confirm, Reopen, Delete with delay, auto-close, channel deleted → "closed without notes".
- ✅ Transcripts byte-identical to v3's txt and HTML formats; to the log with the close details, DM to the member,
  privately to staff on request.
- ✅ Star ratings by DM, once per ticket, logged.
- ✅ Archive of every ticket message (bot cards included) with files, edits and deletes.
- ✅ `/ticket setup` (v3: shows the setup when empty), `/ticket panel` own popup, `/ticket type add|remove|list`,
  `/ticket watch list|view|outcome|add|remove`, `close`, `add`, `remove`, `rename`, `priority`, `info`,
  `transcript`, `stats`; all 14 v3 settings; the three permissions.
- ✅ Staff actions from the dashboard (claim, reply, close) and the ratings/archive pages — with the launcher work. Done: claim, reply and close from the launcher.

## Moderation

Checked against Good Boy 3's behaviour and wording (`more_modules.rs`):
- ✅ `/warn`: the private "Configure warning" message (what happens, DM on/off, 15-minute button, owner only), then the
  form: member picker (left out when known), "Warning reason", Severity (🟢 Low, 🟡 Medium picked, 🟠 High, 🔴 Critical,
  with v3's descriptions), "Duration / severity notes"; v3's checks before it opens ("You cannot warn yourself.",
  "Bots cannot be warned."); severity and notes kept in the case and shown on the case card.
- ✅ Right-click › Apps › Warn member.
- ✅ `/timeout`, `/kick`, `/ban`, `/unban`: v3's option descriptions in the popup; a missing reason (or timeout length)
  opens v3's reason popup (`FIELD` labels, length and ban days kept) from a private button, because Discord can't
  open a popup straight after another; v3's errors ("Use a duration like…", "Discord limits timeouts to 28 days.",
  "Ban length: use something like…", "Days of messages to delete…", "That is not a valid user ID.",
  "Please give a reason - it goes in the log."); timed-ban DM "until <t:…:f>", case reason "(for …)", timeout
  `durationMs` and the Duration line; untimeout and unban replies.
- ✅ Purge: amount up to 100000 or all, one member's, delete or recreate, keep pinned, asks first over 100, progress,
  Stop, bulk delete under 14 days and one by one after.
- ✅ Raid protection, the young-account check, anti-nuke (strip roles, ban, alert; owner DM).
- ✅ Case card: v3's fields, "AutoMod" wording and colours per action.
- ✅ Role checks before acting (v3 `hierarchyError`), ✅ case colours per action, ✅ `/modhistory` shows notes;
  Discord refusing still undoes the case.
- ✅ Severity dropdown descriptions under each choice.
- ✅ The warning form remembers what was typed last time, for 30 minutes (v3 `recall`).
- ⬜ `/modhistory`, `/logs`, `/automod`, `/strikes`, `/unwarn` wording audit; dashboard moderation actions.

## Roles

- ✅ `/rolemenu create`: v3's "New role menu" popup when nothing is filled in (title, text, up to 10 roles, Look,
  How many with v3's descriptions under each choice); v3's error when only part is filled in; v3's option wording.
- ✅ Menus: buttons or dropdown, several or only one, most at once, a role needed, roles that run out; v3's footer
  and lock line; v3's replies when clicked; `/rolemenu limits` and `delete`.
- ✅ Reaction roles and automatic roles, with v3's wording; the same safety rules for which roles can be handed out.
- ✅ `/gamerole add|remove|list`, roles while playing and taken away when they stop (`gameRoleRemove`), v3's
  Presence Intent warning; Presence is only asked of Discord when the bot's owner has switched it on.
- ✅ Member counts on menus ("· **3** members", "3 members" under dropdown choices, refreshed after clicks): needs Done: counts come from the roster and refresh after each press.
  role member counts from Discord.
- ✅ Up to 25 role menu buttons. ⬜ The dashboard's role menu page (v3 panel: limits, delete) comes with the launcher work.
- ✅ Reaction role add checks the message and emoji exist ("I could not find that message in this channel."). Done: the reaction is tried, and if Discord says the message is unknown nothing is saved.

## Member management (welcome)

Checked against Good Boy 3 (`more_modules.rs`): all 27 settings with v3's names, labels and defaults, and:
- ✅ Welcome and goodbye messages, v3's template words; with a picture (`/greeting`, v3's popup and checks: type,
  8 MB, remove) the message is a card with the avatar and the picture shown; pictures kept where v3 keeps them.
- ✅ Welcome back: roles remembered when someone leaves (never the waiting role or roles it may not hand out) and
  given back within `restoreRolesDays`; then no waiting role. Discord's leave event has no roles, so the bot keeps
  each member's roles as it sees them.
- ✅ Verification: `/verify setup` popup (v3's fields) or options, `panel`, `repost`, `status`, `reset` with v3's
  confirm wording; the panel, Verify me, the 3-second guard, v3's replies; the captcha picture drawn as v3 draws it,
  3 tries, 10 minutes, v3's wording; the verified count.
- ✅ Profile roles: setup, edit, remove, view; v3's name and colour rules and wording; placed below the anchor role;
  deleted when the member leaves.
- ✅ `/introduce` popup, posted then edited in place; `/birthday set|remove|upcoming`, the daily birthday message
  and role in the server's time zone (29 Feb on the 28th); `/afk` and the AFK notices (once a minute per channel)
  and "Welcome back" (removed after 8 s).
- 🟡 Replies that link to the posted panel (v3 shows the message link) say the channel instead.
- ✅ v3's channel permission check in `/verify status` (Send Messages, Embed Links, View Channel in the panel's channel). Done server-wide (a channel's own rules can still say no).
- ⬜ The picture preview after `/greeting` shows the upload's own link while the copy is being kept.

## Economy

Checked against Good Boy 3 (`money_on_3x_data.rs` on real 3.x wallets, `more_modules.rs`): v3's commands replace
v4's `/money` group, with v3's tables, numbers and wording:
- ✅ `/balance` (wallet card, Daily / Leaderboard / Pay someone), right-click View wallet and Pay member, `/daily`
  (streaks, shields, milestone bonuses, checked against v3's own function), `/pay` (v3's private message, then the
  form; v3's errors), `/work` (pet bonus and work boost), `/economy-admin` (give, take, set; ledger reason).
- ✅ `/top`: v3's live leaderboard, Richest and Daily streak, 10 a page, ◀️ / ▶️ disabled at the ends, refresh, this
  server or global (opted-in servers only), "You" line, someone else's press gets their own copy.
- ✅ `/shop`: Streak Shield, Padlock (when robbing is on), the four built-in items (price and on/off kept as v3 keeps
  them), staff items (Add item popup with v3's "hours | stock | emoji" and "!" for used-up items, Remove item),
  roles for good or for some hours (taken away when time's up), stock, inventory and using items, boosts.
- ✅ The weekly lottery: tickets, the pool, drawn on Monday (one ticket, one chance), the winner's DM and the
  announcement channel.
- ✅ `/bank`: deposit, withdraw, daily interest compounding with the daily cap, paid when looked at.
- ✅ `/pet adopt|feed|play|info`: the eight pets and prices, hunger and happiness over time, levels, the /work bonus.
- ✅ `/rob`: off unless switched on, v3's chances, limits, cooldowns, padlocks and fines.
- ✅ Coin events while people chat (grab or share), at most one every 10 minutes; the ledger kept 30 days.
- ✅ All 17 v3 settings and both permissions.
- 🟡 "Reset the economy" (a v4 extra) is a button on `/economy-admin` and in the launcher.
- ✅ Fishing and other game boards on `/top` (they come with the games module); the dashboard's Shop page. Done: a Shop page in the launcher.

## Reminders

- ✅ `/remind me|team|list|cancel`, v3's limits, time checks and wording; reminders saved in v3 still arrive.
- ✅ `/remind team`: v3's one popup (message, when, channel, up to 5 roles, repeat); with the roles and time given but
  no text, the text is asked in its own popup; v3's errors.
- ✅ Delivery: team reminders with each role on its own line, personal ones by DM with "(set in …)", or in the
  channel when DMs are closed; "sent late" when the bot was offline; daily and weekly repeats.
- ✅ The warning when the roles can't be pinged (missing permission) and members' "no DMs" preference. Done: the warning and the "no DMs" choice.

## Giveaways

- ✅ `/giveaway start`: v3's private message and "Set up the giveaway" button, then its form (prize, 1d, 1 winner,
  channel, role); v3's checks and wording. `end`, `reroll`, `list`.
- ✅ The post: Enter / leave with the live count, v3's lines, the greyed-out Ended button; fair draws; coin prizes
  paid while the economy module is on.
- ✅ Who may win is checked at Enter (role), and members who left by the draw are skipped.

## Tags, counting, fun, music

- ✅ Tags: the same commands, options, `cc:` data, TagScript and replies (checked in `more_modules.rs`).
- ✅ Counting and word chain: the same rules (checked against v3's own functions), replies, stats, reset, and v3's
  "👀 … deleted their number" when the latest number is deleted.
- ✅ Fun: 8-ball, dice, ship, topic, checked against v3's own functions.
- ✅ Music: v3's `/music` posts the player and everything is on its buttons; v4 has the same player and settings,
  plus extra parts (`/music play`, `queue`, `lyrics`, playlists) as shortcuts.

## Utility

- ✅ `/highlight add|remove|list|clear`, v3's whole-word matching, limits and wording; the DM with the jump link,
  never from a channel the member can't see (checked with Discord's permission rules), once per channel every
  5 minutes, not while they were chatting there; the Message Content warning.
- ✅ Right-click a message › Apps › Translate, privately, in the member's Discord language (Google's free endpoint).

## Roleplay

- ✅ `/rp` with v3's twenty actions, wording, counts (`roleplay_counts`), "… back" button (only for the member it was
  done to), solo actions, the three settings, the bot owner's Tenor key popup.
- ✅ Good Boy 4 change (asked for by the owner): no drawn animations; furry GIFs from Tenor (strict safe search) shown
  privately to pick from, then posted; "do it back" takes one at random; without a key the action is posted
  without a GIF.
- ✅ Supporters picking a GIF style (furry, anime, animals, cartoon): the roleplay setting "GIF style", used when the
  bot's licence has the supporter perks (furry otherwise).

## Invites

- ✅ Which invite each member used (counts before and after the join, one-use invites that vanish, the server's
  custom link), v3's `invites_joins` table, `/invites user|top`, the "joined, invited by" line, new accounts.

## Modmail

- ✅ DMs to the bot go to the server's staff (the member picks when they share several servers with modmail), a
  thread (or forum post) with v3's header card, Close and Block; staff answers go back by DM as "Staff" or their
  name, `//` notes stay; 📨 / ⚠️ on each answer; v3's greeting and closing messages; v3's data keys.
- 🟡 Closing shows a short header in place of the original card.

## Backup

- ✅ `/backup save|list|preview|restore|delete`, v3's layout snapshot (roles, categories, channels, permissions),
  restore only adds what is missing and never deletes, weekly automatic backups, v3's wording.

## Messages

- ✅ `/say send|edit` (v3's builder: title, text, colour, picture, buttons), `/sticky set|remove|list` with the
  message reposted after the chat moves on (one at a time per channel), v3's data and wording.

## Dead chat

- ✅ v3's quiet-chat ping: setup popup, the opt-in button and role, the quiet and cooldown rule, conversation
  starters, v3's wording.

## Eclipse ID

- ✅ `/id show|edit|privacy|link|unlink|roblox|delete`, v3's tables (`eclipseid_ids`, `eclipseid_profile`,
  `eclipseid_link`), the same ID number in every server, per-part privacy (everyone, staff, only me), v3's link
  checks for nine platforms, the optional Roblox name check, v3's wording.

## Families

- ✅ `/marry`, `/family tree|info|adopt|divorce|disown|leave`, v3's tables (`family_partners`, `family_children`),
  v3's rules (no marrying family, one parent per child, partner and child limits), Accept/Decline with the
  10-minute limit and taking it back, confirm buttons, the family tree picture with avatars (the text tree when it
  can't be drawn), v3's wording.

## Achievements

- ✅ v3's 17 built-in achievements (messages, voice hours, reactions, days active, streaks, days in the server),
  the 20-second message and 5-second reaction limits, voice time outside the AFK channel (12 hours at most per
  session), streaks by the server's timezone, announcements (channel, DM, both, off), `/achievements
  show|list|privacy|optout|optin|custom create|delete|grant|revoke`, v3's five tables and wording, the summary on
  the Eclipse ID card.
- 🟡 Voice sessions open when the bot starts are not counted until the member moves (v3 started them on start-up).

## Notification choices

- ✅ `/notifications view|set|server-default` with v3's seven categories and defaults (member's choice, then the
  server's, then the default) and `notification_prefs` table; achievement announcements follow it.

## Clips

- ✅ v3's clips channel: uploads, clip links and Medal's "shared a clip" posts (the member credited), titles found
  later, the vote emoji (a server's own emoji too), votes counted without the owner and bots, Best clips reposted
  once (links as text so the video plays, uploads uploaded again up to 10 MB), clip of the week every Monday with
  the prize, coins per clip with the daily cap, `/clips top|setup`, v3's `clips_list` table and wording.
- 🟡 The "Clips shared" and "Clip votes" boards in `/top` wait for the other boards (levels, fishing).
- 🟡 Boosted servers' bigger upload limit (50/100 MB) is not used yet.

## Bot news

- ✅ v3's bot news: every update's full notes to the admin channel, the members part to announcements (plain
  messages split to fit, or a card), the draft to reword first (Edit & post, Post as it is, Skip), new modules,
  modules turned on/off from the launcher, v3's member intros the first time a feature is on, the ping role,
  `/botnews setup|test`, v3's data keys. The notes come from this build's own CHANGELOG.md.
- 🟡 The ping role is used without first checking the bot may mention it (v3's pingProblem).

## Party finder

- ✅ `/party create|list|close|kick` with v3's popup, rules (slots 2–99, limits per member and server, start times
  up to two weeks ahead), the post with Join/Leave/Close, the optional voice channel (removed once empty), DMs when
  a party fills and 10 minutes before it starts (following "party invitations"), parties that end on their own or
  when their post is deleted, the ping role, v3's data keys and wording.

## Quotes

- ✅ Right-click > Apps > Quote Image / Quote Image (Color) and `/quote message style`, v3's picture (the speaker's
  picture fading into black, black and white or colour, the words fitted, name, handle and date), motion quotes
  (a slow zoom and a shine), animated profile pictures moving, smaller GIFs when too big and the still picture
  when anything fails, one moving quote drawn at a time, the 8-second wait, the quote channel with a private link,
  the "can you see that channel" check, v3's wording.
- 🔄 Deliberate changes in v4: the card is drawn in the launcher's pixel look (pixel frame, pixel fonts, a text cursor) instead of v3's black card; the speaker's picture is pixel art (a setting turns it off); the zoom of a motion quote became a stepping light band so pixels stay square; a picture in the quoted message is shown under the words; members cannot quote their own messages (a setting allows it); characters the pixel fonts lack are drawn in the computer's own fonts.

## Critters

- ✅ Good Boy 3's collecting game, with one deliberate change: **no characters come built in.** Staff build their
  own roster with `/critters add` (name, type, rarity, a picture address, hp/attack/defense/speed),
  `/critters remove` and `/critters roster`. Wild ones appear only from that roster, by rarity.
- ✅ Everything else as in v3: wild ones appearing while people chat, Catch with the name popup and Hint, running
  away after 3 minutes, sparkly ones, buddy XP, `/critters list|info|buddy|rename|dex|trade|battle|release|here|spawn`,
  v3's battle and stat formulas, release coins, v3's tables and wording. Critters whose character was removed
  keep working.
- 🟡 Character packs (sharing a roster between servers) and the launcher's roster editor come with launcher parity.

## Integrations

- ✅ `/feed add|remove|list|check|twitch-keys` for RSS/Atom, YouTube (ID, URL or @handle), GitHub
  (releases/commits/tags), Reddit, Twitch and Kick live alerts, Bluesky and Mastodon; new items only (at most 5 per
  check, oldest first), message templates, back-off on failures and removal after 30, `/minecraft`, v3's data keys
  and wording. Fetching only reaches public addresses, with a size cap and a time limit.
- ✅ `/webhook create|list|delete` (only the secret's hash is kept) and the posting of what a webhook receives.
- 🟡 Nothing receives webhook calls yet: the bot has no web address to accept them. That comes with the staff web
  dashboard (the "{address}" in the created link is filled in then).

## Voice (text-to-speech)

- ✅ `/tts say|join|leave|skip|stop|queue|voices|voice|setup|reading|diagnose`, v3's queue (20 waiting, 5 per
  member, a wait between a member's messages), text cleaned for speech (links, mentions, emoji ids, markdown),
  Windows' own offline voices or Google's speech service with each as the other's fallback, per-member voice and
  language, the no-mic channel (read aloud as "Name says …", only for members in the bot's channel, other bots'
  commands skipped, opt out with `/tts reading`), leaving when idle or alone, ⚠️ on failures, v3's settings and wording.
- ✅ Speech plays over the same voice connection as music (the two mix), so the bot can talk while music plays.
- 🟡 `/tts voice name:` keeps the name as typed; v3 checked it against the installed voices (an unknown one is
  ignored when speaking). The playing message is not edited into "Speaking/✅" as v3 did.

## Temporary voice rooms

- ✅ `/voicehub add|remove|list|event` and `/room name|limit|privacy|invite|permit|kick|ban|transfer|claim|info`:
  join a lobby and a room of your own appears with you in it (permissions from the category or lobby, a name
  template, limits, one room per member, 10 seconds between makes, a cap on rooms, a DM when full), removal when
  empty after the wait, owner handover (to who was there longest, or `/room claim`), two renames per 10 minutes,
  rooms remembered across restarts, v3's tables and wording.
- ✅ Event hubs: the popup, the sign-up panel (Join solo, Join with friends with accept/decline, Make a team room,
  Leave, Lock, End), the team queue, a locked room per team that anyone already in voice is moved into, grace time
  for new team rooms, spots filled from the waiting list, v3's rules.
- 🟡 The room's link in a team's "ready" message and on the panel appears a moment after the room exists (v3 waited
  for the room first).
- 🟡 Other bots in voice are only recognised once they have moved; at start-up they are counted as people.
- 🟡 The dashboard and phone views for event hubs come with launcher parity.

## Engagement (announcements, polls, suggestions, starboard)

- ✅ `/announce send|schedule|list`: v3's private intro and popup (channel, title, text, colour, role pings with
  @everyone), plain messages that really ping or a coloured card, schedules (once, hourly up to weekly) kept in
  `sched:`, listed with a dropdown to cancel, up to 25.
- ✅ `/poll create|end`: 2 to 5 choices, bars, one vote each (or several), a time limit up to 30 days, ends by itself
  and announces it. `/suggest` and `/suggestion setup|status|info|top|mine|edit|delete`: the vote buttons, the five
  statuses, staff notes, the author's DM, cooldown, anonymous suggestions, v3's records.
- ✅ `/starboard setup|status|enable|disable|channel|emoji|threshold|options|ignore add|remove|list|top`: stars
  counted without bots (and the author unless allowed), NSFW and ignored channels, removal when below, the board's
  copy kept up to date and removed when the original is deleted, custom emoji.
- ✅ Suggestion discussion threads are opened (on by default, as in Good Boy 3). The checks for "I can't ping here" (v3's pingProblem) are not
  made, so an announcement that Discord won't ping for is posted without telling the sender.
- 🟡 The phone and dashboard "announce" view comes with launcher parity.

## Stats and counters
Same as Good Boy 3: `/stats member|me|server|top|coverage|recap|backfill|inactive|optout|optin|forget`, the "Message stats" user command, `/counter add|remove|list`. Messages, reactions and voice time are counted per member, channel, day and hour (message text is never stored); weekly recap, monthly review, "we miss you" nudges and counter channels (every 10 minutes) run from the clock. The inactive list never shows bots, staff, exempt roles or new members, and kicking always asks first.
Differences: `/stats backfill` reads text channels only (no threads or forums, no resuming, no live progress message) and reports back by DM. The `/counter add` reply does not repeat the channel name.

## Other modules

Not started yet: games (slots, blackjack, coinflip, fishing, minigames).

## Music: more bots, moving, cut-outs
- ✅ Extra music bots ("helper bots", up to 9): add a token under **Bot settings > Music bots** in the app (or `DISCORD_HELPER_TOKENS` for the command line). Each helper has its own queue and player, plays in its own voice channel at the same time, and `/music play` picks the bot already in your channel, else a free one. `/music bots` lists them with the add-to-server links.
- ✅ Move the bot: `/music move [channel]` and `/music join`, the music keeps playing; dragging the bot by hand is followed too.
- ✅ Cut-outs: the sound now follows Discord when it moves the call to another voice server (before, the bot went silent until restarted).
- ✅ New commands: pause, resume, now, playnext, remove, clear, shuffle, repeat [mode], skipto, seek, forward, rewind, stay (24/7), grab (DM the song), bots.
- ✅ Vote skip (`voteSkip` setting, `/music voteskip`, or Skip when not allowed) and saved favourites (`/music favorite|favorites|playfavorite|unfavorite`).
- ✅ Sound filters (bass boost, nightcore, slowed) for downloaded songs: `/music sound filter`, a setting and a launcher menu. Done in Rust on the decoded sound (no outside program); tested on tones and real mp3, ogg, flac and m4a files. ⬜ Not checked by ear on live Discord; radio and live streams are never filtered. ✅ A dropped radio stream is picked up again up to six times. ✅ Autoplay.
- `/music volume` is now `/music sound volume` (Discord allows only 25 parts in one command).

## Version 4 upgrade plan (beyond Good Boy 3)
Order: moderation, remaining v3 ports (games), community features, launcher-as-dashboard.

**Moderation:** one case timeline per member; automatic evidence (deleted/edited messages, purges); smart AutoMod (raid patterns, new-account rules, safe mode with restore); alt and ban-evasion check (flags for review, never auto-bans); second-staff approval for big actions; appeals in Discord with a staff vote; staff accountability reports and an undo window; escalation ladders with expiring warnings; mod notes and a watchlist; right-click report button.

**Community:** new-member journey with a buddy and quiet-member nudges; at-risk member alerts; member profiles (pronouns, timezone, birthday); daily/weekly prompts and streaks; events calendar (RSVP, per-person timezones, recurring, recap); community goals; suggestion statuses; member of the month and seasons; staff applications with scoring; announcement drafts and approval; server health digest; unused channel/role cleanup hints; server templates; slow-mode automation; webhook inbox.

**Per module:** levels (seasons, reward previews, anti-farm), economy (taxes, treasury, exchange), tickets (SLA timers, workload view), music (filters, autoplay, vote-skip, favourites), stats (charts, growth forecast), giveaways (fraud checks, requirement presets), welcome/verify (risk-scored onboarding), logs (searchable audit trail).

## Moderation upgrades (built)
- ✅ `/note add|list|remove` (private staff notes), `/watch add|remove|list` (watchlist: a note in the mod log when a watched member posts, at most every 10 minutes).
- ✅ `/appeal` for warnings and timeouts, with a staff vote (`appealVotes`), taking back the warning or lifting the timeout, and a DM with the answer.
- ✅ Second-staff approval for bans (or kicks and bans): `needApproval`. Administrators are never held up; the person who asked can't approve their own request.
- ✅ Warnings that expire (`warnExpireDays`): they stay in the history but stop counting as strikes.
- ✅ Ban-evasion alert: a new member whose name matches a banned member's (hint only).
- ✅ `/report` and right-click > Apps > Report message: goes to the report channel with the text, a jump link, and a "Warn author" button.
- ✅ `/lockdown on|off|status`: locks every text channel for @everyone and puts each channel back exactly as it was.
- ⬜ Still to do: automatic evidence on cases, raid-pattern AutoMod and safe-mode restore, staff accountability reports, undo window, a per-member timeline view with notes and appeals together, alt matching beyond names.

## Games: new slots and blackjack (fishing stays as Good Boy 3 has it)
- ✅ Slots redone: 3×3 window with the middle line paying, a wild card, a progressive jackpot, a hot streak (up to +20% on wins in a row), Spin again / Auto ×5 / Bet ×2 / Bet ½ buttons. About 94.8% returned (tested).
- ✅ Blackjack redone: hit, stand, double, split, insurance (2 to 1), surrender, 4 decks, dealer stands on 17, blackjack pays 3 to 2, unfinished hands stand and are paid after 10 minutes. Deal again / Bet ½ / Bet ×2 buttons.
- ✅ Coin flip (1.95×) with Again / Switch side.
- Settings: each game on/off, smallest and biggest bet, private results, jackpot start and share.
- ✅ `/top` has Good Boy 3's fishing and casino boards (most fish, heaviest catch, fishing level, casino winnings); game results are kept in v3's own `games_stats` table. ✅ Big-win and rare-catch announcements (off by default, same rules as Good Boy 3).

## Fishing (kept exactly as Good Boy 3 has it)
- ✅ The rules (`fishing.rs`): all 15+ places, the 2,000 fish (same names, ids, sizes, prices), rods with perks and stars, bait, tackle, the level curve to 4,000, what bites, the strike and surges, the reeling mini-game. The tests compare it with answers recorded from Good Boy 3 itself (`fixtures/fishing.json`): every fish, the level curve, 400 catches and 150 whole reeling games step by step all match.
- ✅ Daily and weekly challenges' rules (`fishchallenges.rs`): which ones a member gets, goals, rewards, streak bonus, progress and wording; compared with Good Boy 3's own answers (`fixtures/fishchallenges.json`).
- ✅ The screens (`fish.rs`), on Good Boy 3's own tables (`games_fish_*`, same SQL): `/fish` hub; the cast popup (place, rod, bait, tackle, each starting at your last choice, with a hint under each choice); reeling with Pull / Reel / Slack / Cut buttons and the bite shown at the right moment; strike and surges; catch results with XP, level-ups and unlocked places; bag with sell-chosen / sell-all-but-rare-finds / sell-everything; tackle shop (rods, tackle, bait by amount); rods with perks, home places and ★ upgrades; collection per place with pages; daily and weekly challenges with streak and bait rewards; sunken rods in Ironwreck Graveyard; keepsake rods; challenge rods; the lucky-charm boost.
- ⬜ Not yet: see the list above.

## Game pictures (to match the games preview)
- ✅ `gb-art/src/games.rs` draws the slot window (3×3, payline, eight symbols, result banner), the blackjack table (cards, hidden card, split hands, results), the coin, and the fishing scene (place colours for every place, bobber that dips on the bite, rarity badge, green zone and fish, Catch and Tension bars) plus the catch and got-away pictures. `gamePictures` turns them off (text versions stay).
- ✅ On a game's card the picture sits between the title and the lines, as in the preview. Fishing's hub shows the XP bar.
- ✅ Animated (`gameAnimations`, on by default): the reels spin and stop one by one, the coin is tossed and turns over, the first four blackjack cards are dealt one by one and the dealer's cards are turned over one by one at the end, the water drifts and the float bobs while fishing (and jerks on a bite, with the fish wriggling in the fight bar), a caught fish leaps out of the water, and the ripples fade when one gets away. Films that show a result play once and rest on the last frame; the fishing scene loops.
- ⬜ Members who switched off "automatically play GIFs" in Discord see the first frame until they click; the result is always in the text under the picture as well.

## The arcade (redesigned for version 4)

Good Boy 3's six arcade games and Pong are here, each redone with a picture, an animation and one new idea. The odds
start from Good Boy 3's numbers; what changed is listed.

| Game | Command | Same as Good Boy 3 | New in version 4 |
|---|---|---|---|
| Balloon Rescue (hangman) | `/hangman` | 97 words, 6 wrong guesses, 1.3x + 0.15x per guess left, a wrong whole word costs 2 | The word is drawn as blanks, tried letters in green or red, balloons in place of the gallows, a category clue, a hint that costs a balloon, a bonus (up to 0.5x) for guessing the whole word early |
| Treasure Climb (tower) | `/tower` | 8 floors, 3 doors, 1.45x per floor, cash out any time | A golden door on floor 5: skips a floor (2.1x), opens 46 times in 100 |
| Bomb Squad (wires) | `/wires` | 5 wires, one bomb, 96% of fair odds | Good Boy sniffs out one safe wire once a game (set aside, changes no odds) |
| Bingo | `/bingo` | Numbers 1 to 20, 10 draws | A 4 by 4 card, balls that drop, "Drop them all", new pay table (20x to 1.4x, about 95% back), two lines at once pay double |
| Memory | `/memory` | 16 cards, pay by mistakes | A square board of buttons; three matches in a row add 0.2x, five add 0.5x |
| Trivia | `/trivia` | The same 73 questions, 20 seconds | A timer bar that runs down, 1.8x within 7 seconds and 1.6x after (v3: 1.7x), +0.05x per right answer in a row (up to 0.3x), Next question button |
| Paddle Duel (pong) | `/pong` | Against Good Boy or a member, no coins | A new game: aim top, middle or bottom, or smash; the other player picks where to stand. First to 5. (v3's grid Pong is not kept.) |

`/arcade` posts the panel (admins); each button opens that game's bet popup. Games left for ten minutes are settled:
a climb or a bomb is cashed out where it stood, a bingo card is drawn to the end, a memory board or a word is lost.

- ⬜ Not checked on live Discord yet. Trivia answers can be learned by heart (as in Good Boy 3), so it pays out more than it takes from players who do.

## Fishing screens as pictures (new in version 4)
The hub, bag, shop, rods, collection and challenges are pictures now: the place's own water scene (moving) with the title and key numbers,
then tiles with rarity colours, stars, progress bars and prices. The words, numbers and buttons come from the same data as before; the
gameplay is unchanged. With pictures turned off they are the old text screens.

## Try every game
`Good-Boy-game-preview.exe` (on the private Releases page with each test build) opens a Discord look-alike page where every game runs on
the real bot, with a fresh wallet. Locally: `cargo run --release -p gb-core --example emulator -- 8787`.

## Memory (picture)
Memory is a picture now like the other arcade games: a 4 by 4 board of drawn cards that flip over (a moving picture), a combo badge, pairs found, mistakes and what it pays right now; the buttons underneath are the card numbers. A wrong pair stays face up (outlined red) until the next flip. With pictures off it keeps the face buttons and words.

## Dashboard pages (launcher and phone)
- ✅ Home, Modules (with each module's settings), Tickets, Members, Inactive, Leavers, Moderation, AutoMod, Economy, Shop, Role menus, Lists (giveaways, custom commands, top inviters, counting, backups), Permissions, Music, Check-up, Logs, Settings, Help; the phone web app has the same pages.
- ⬜ Not in the dashboard: backups can be listed but not made or restored there (use /backup in Discord); v3's web-only pages for art uploads and tester feedback.
