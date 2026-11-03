# Engagement research (2.2)

What keeps people coming back to the most-used economy and collection bots, and what Good Boy 2.2 takes from them.

> **Source note.** This comes from how these bots are widely known to work: their public commands, documentation and community guides. It was not re-checked against their live versions for this release, and their exact numbers (cooldowns, odds, prices) change often. Treat it as the shape of each design, not a spec. None of their content, names or assets are copied. Good Boy only borrows general mechanics that are common across the genre.

## 1. The bots

### Dank Memer (meme-themed economy)
- **Loop:** many short "earn" commands on separate cooldowns (beg, search, fish, hunt, dig, post memes, work a job), each paying a little coins and sometimes an item. A session is a run through whatever is off cooldown.
- **Progression:** levels and XP from using commands, prestige resets for permanent multipliers, jobs with promotions, skill trees.
- **Streaks and multipliers:** a daily reward that grows with the streak, plus weekly and monthly rewards. Coin multipliers stack from many sources (level, items, events, premium) and are shown as one percentage.
- **Item economy:** hundreds of items (tools that unlock commands, consumables, collectables), a shop whose stock rotates, trading between players, and lootboxes with tiered rarity.
- **Sinks:** gambling (slots, blackjack, roulette, coin flip) with a house edge, item wear, robbery risk, taxes on transfers.
- **UI/UX:** heavy use of buttons for multi-step events, for example the "search" command offers three places as buttons. Many games resolve in one or two clicks. Embeds are compact and use one strong colour per result type (green win, red loss).

### Karuta (card collecting)
- **Loop:** a bot "drop" of a few cards appears in a channel and the first person to react claims one. Grab and drop cooldowns pace the session (minutes, not hours).
- **Progression:** collecting cards of characters, card *quality* and *print number* (low prints are rare), upgrading quality with resources, frames and dyes for customisation.
- **Item economy:** cards are the currency. A player-driven trading and auction culture, and wishlists that ping you when a wanted card drops.
- **UI/UX:** the drop is a single generated image with reactions or buttons. The race to click is the hook. Collection views are paginated embeds with filters and sorting.
- **Lesson:** scarcity you can *see* (a print number, a condition) makes ordinary actions exciting, and social competition in a public channel spreads the bot.

### Mudae (character rolling and claiming)
- **Loop:** a fixed number of rolls per hour and one claim per few hours. Rolling shows a character card, and anyone can claim it with a reaction until the claim timer resets. Timers reset on a predictable global schedule, which creates "rush hours" where everyone is active together.
- **Progression:** a harem/collection that grows, "kakera" currency from reacting to rolls you own, upgrades bought with kakera (more rolls, better odds).
- **UI/UX:** almost everything is one short command plus reactions. Collection browsing is paginated with arrow reactions or buttons.
- **Lesson:** a shared reset schedule turns a solo bot into a social event. Rationing (rolls per hour) makes each action feel valuable and stops spam.

### TacoShack (idle tycoon)
- **Loop:** you run a shop that earns money while you are away. You come back to collect, then spend on upgrades that raise income. Hourly, daily, weekly and vote rewards stack.
- **Progression:** a long upgrade tree with rising costs, franchises (prestige), employees and decorations that each add a little income.
- **UI/UX:** status embeds with clear numbers ("income per hour", "next upgrade cost"), and buy/upgrade flows that confirm in one click.
- **Lesson:** "come back later, something is waiting for you" is the strongest retention hook, and upgrades are satisfying when the effect on a visible number is immediate.

## 2. Patterns across all four

| Pattern | Why it works | Risk |
|---|---|---|
| **Short cooldown actions** plus **long daily/weekly rewards** | Two rhythms: a quick session now, and a reason to return tomorrow | Too many cooldowns become a chore checklist |
| **Streaks that grow** | Losing a long streak feels bad, so people come back | A single miss feels punishing enough that people quit; protection items soften it |
| **Visible rarity** (tiers, colours, print numbers, mutations) | Every action is a small lottery ticket, and rare results are worth sharing | Too-rare items make the common case feel like failure |
| **Upgrades with obvious effects** | "I bought X, now Y is better" closes the loop | Hidden or tiny effects feel like a scam |
| **Coin sinks** (gambling with a house edge, consumables, upgrades with rising costs) | Keep prices meaningful and rewards worth chasing | Without sinks, inflation makes everything worthless within weeks |
| **Public results** | Other members see big wins and join in | Spam in busy channels; bots give games their own channel |
| **One-click repeats** ("play again", "spin again") | Removes friction for the second and later plays | Endless repeats without a rest feel compulsive; bets should stay deliberate |
| **Pagination** for collections and leaderboards | Large lists stay readable on phones | Stale pages, or other people paging your view |

### Button fatigue: what the snappy ones do
- **Few buttons, clear labels.** Two to four buttons per message, with the main action highlighted (primary or success colour) and destructive actions in red.
- **Edit the same message** instead of posting new ones for each step, so the channel stays clean and the eye stays in one place.
- **Disable what cannot be used** (Previous on page 1, Double after the first hit) instead of answering "you can't do that" after the click.
- **Remember the last choice.** A repeat button that reuses the last bet or setup, with a separate "change" button, removes most of the typing.
- **Keep private things private.** Menus, shops and settings are ephemeral. Big results are public.

## 3. What 2.2 builds from this

### Recommendation 1: a forgiving daily streak *(built)*
Claims open every **20 hours**, so the time can drift a little each day, and the streak survives **48 hours**. Each day adds +5% (capped at +150% on day 30), with milestone bonuses on days 7, 14 and every 30. Every 7 days earns a **Streak Shield** (hold up to 3) that saves the streak once after a miss. You get the "don't lose it" pull without the "I missed one day, I quit" cliff. *Code: `src/economy.js` `claimDaily`, `/daily`.*

### Recommendation 2: one-click repeats, deliberate bets *(built)*
Every game result has **again** (same bet or setup, one click) and **change bet** (reopens the popup, pre-filled). Bets themselves are always typed in a popup, so changing the stake is a conscious act. The fishing hub remembers your last place, rod, bait and tackle. *Code: `modules/games` "again" buttons, `src/modalpipe.js` pre-fill.*

### Recommendation 3: visible rarity and a collection to finish *(built)*
Fishing has 6 rarity tiers with colours, rare **Mutated** and **Corrupted** variants and giant weights. It also has a **collection log** (108 fish across 9 places, which unlock with level up to level 100) and daily and weekly challenges with a streak and hype lines for legendary and mythical bites. Better rods, bait and tackle visibly change the odds and the reeling. *Code: `src/fishing.js`, `/fish` → Collection.*

### Recommendation 4: a shared jackpot and live boards *(built)*
Every slots bet feeds a **server-wide jackpot pool** shown on the arcade panel and the bet popup, so everyone is playing for the same prize. The pool is also a coin sink. The **live leaderboards** (`/top`) cover coins, streaks, catches, heaviest fish, fishing level and casino winnings, per server or globally for servers that opt in. *Code: `modules/games` jackpot, `modules/economy` boards.*

### Considered and left out of 2.2
- **Robbing other members.** It drives engagement in some bots but creates real-feeling conflict and moderation work.
- **Trading and auctions.** Strong for retention, but needs scam protection and audit tools before it is safe.
- **Lootboxes.** Fishing already gives the "open a mystery" moment without a paid-feeling box.
- **Selling coins or boosts for real money.** Never. It turns the casino games into real gambling.

## 4. Healthy-play guard rails
- Coins are play money and cannot be bought, sold or cashed out.
- The casino keeps a house edge (slots about 94.6% return, coin flip 1.95x on even odds, blackjack standard rules) so the economy does not inflate.
- Admins can turn each game off, set the smallest and biggest bet, and see every wallet change in the ledger (kept 30 days).
- Fishing fights end on their own after 45 seconds without a press. Blackjack hands left alone for 10 minutes stand automatically and are paid.
