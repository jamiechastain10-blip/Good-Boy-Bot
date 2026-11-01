# Economy, leaderboards and games (2.2)

How the economy and games modules work: the flows, the stored data, and the rules that keep them safe across hot reloads.

## 0. The modal pipeline (used by everything below)

Discord lets a popup (modal) be the **first** response to a slash command, a context menu or a button, but never the response to another popup. Good Boy 2.2 always puts a button first:

```
/warn                     -> private message: "Configure warning" [button]
  click                   -> popup opens (fields built now, so they show fresh data)
    submit                -> the form's submit() runs; a mistake answers with the error + "Try again"
```

Each button and popup ID is a signed token, `<ns>:m1:<step>:<form>:<owner>:<issued>:<nonce>:<args>:<sig>`:

| Part | Meaning |
|---|---|
| `ns` | which module (`mpm` moderation, `mpe` engagement, `mpx` economy, `mpg` games) |
| `m1` | token **format** version, not the bot version, so an update does not break open buttons |
| `step` | `o` open the popup, `s` submit it |
| `owner` | who ran the command; anyone else gets "belongs to someone else" |
| `issued` | base-36 seconds; expires after 15 minutes |
| `nonce` | 4 random characters, so two forms opened in the same second differ |
| `args` | context: a target user, a bait id... (ids and short words only) |
| `sig` | HMAC-SHA256 of the rest, keyed by a secret stored in the database (`schema_meta`), so it survives restarts |

On every step the pipeline checks the signature, the owner, the expiry, and the form's permission (again). A submitted popup is remembered until it expires, so it cannot be submitted twice. Nothing is kept in memory between steps, which is why a hot reload or a restart in the middle of a form changes nothing.

`createPipeline({ ns, forms })` gives a module `launch` (command → button), `open` (any click → popup), `button` (a button for the module's own messages) and `component` (the router). See the comment at the top of `src/modalpipe.js`.

## 1. Economy (`modules/economy`)

### Data
```sql
economy_wallets (guild_id, user_id, name, coins, earned, streak, best_streak, shields, last_daily, created_at)  PK (guild_id, user_id)
economy_ledger  (id, guild_id, user_id, delta, reason, at)    -- every change, kept 30 days
```
- Coins are only taken with `UPDATE ... SET coins = coins - ? WHERE ... AND coins >= ?` (one statement), so two quick clicks can never spend the same coins twice.
- Multi-step changes (a payment, a daily claim) run in one transaction.
- `name` is refreshed whenever someone uses the economy. It is used on the global board, where mentions would not render.

### Commands
| Command | Flow |
|---|---|
| `/balance` | wallet card + buttons: Daily, Leaderboard, Pay someone (opens the pay popup directly) |
| `/daily` | claims; see the streak rules in `docs/ENGAGEMENT.md` |
| `/pay` | button → popup (who, amount, note). Right-click → **Pay member** puts the target in the token, so the popup asks only for the amount |
| `/top` | live leaderboard (below) |
| `/economy-admin` | admins: button → popup (member, give/take/set, amount, reason). Logged to the ledger and the bot log |

Amounts accept `500`, `1,500`, `2.5k`, `1m`, `half` and `all`.

### API for other modules
`ctx.api('economy')`: `wallet(guildId, userId)`, `credit`, `debit` (throws a readable error if short), `format`, `transaction(guildId, fn)`, `registerBoard(board)`.

## 2. Live paginated leaderboards (`src/leaderboard.js`)

```
🎣 Most fish caught · My Server              [Choose a leaderboard ▾]
🥇 @alice · 412 fish
🥈 @bob · 380 fish
...
` #10` @jo · 51 fish
You: #42 · 12 fish
120 entries · page 1 of 12 · live
[◀️ (off)] [1 / 12] [▶️] [🔄] [🌍 Global]
```

- **Architecture:** the message stores nothing. Every button ID is `econlb:<owner>:<board>:<scope>:<page>:<action>`.
- **Live data:** each click runs a `COUNT(*)` and a `LIMIT 10 OFFSET page*10` query against the database before editing the message. Nothing is cached. If the board shrank since the button was drawn, the page is clamped.
- **Boundaries:** Previous is disabled on page 1 and Next on the last page; the page label is a disabled button.
- **Session lock:** a click from anyone but the owner leaves the owner's message alone and answers privately with a fresh copy that belongs to the clicker.
- **Boards** are SQL sources (`guild_id, user_id, name, value`) registered by modules. Economy adds coins and streak; games adds fish caught, heaviest catch, fishing level and casino winnings. The picker only shows boards whose module is on in the server.
- **Global scope** shows one line per person (their best server) and only includes servers whose admins turned on `globalBoard`. It shows stored names instead of mentions.
- **Mobile:** one short line per rank, at most 5 buttons per row, so nothing wraps on a phone.

## 3. Games (`modules/games`)

### Shared rules
- **Popup-first:** every game command serves a private button → bet popup. The arcade panel's buttons open the popup directly, because the click itself is the trigger.
- **Decided, then shown:** a spin or flip is decided and paid inside one transaction *before* the animation. The animation (about 3 edits, 750 ms apart, well inside Discord's edit limits) only reveals it.
- **Sessions in the database:** `games_sessions (id, guild_id, user_id, kind, state JSON, created_at, updated_at)` holds blackjack hands and fishing fights. Buttons carry only the session id; the owner is checked against the row.
- **Again buttons** carry a bet, so they are signed with the pipeline key (`gmx:` tokens, valid 1 hour).
- **Clean-up task (every minute):** a hand idle for 10 minutes stands automatically and is paid; a fight idle for 10 minutes is dropped.

### Slots
1. `/slots` → **Set bet** → popup (bet, pre-filled with your last bet).
2. Submit: take the bet, add 3% of it to the server jackpot pool, spin 3 reels (crypto RNG), pay.
3. Message: `🌀 🌀 🌀` → first reel stops → second → third plus the result, then **Spin again (bet)** and **Change bet**.

Pay table (bet ×): three cherries 6, lemons 10, grapes 18, bells 40, stars 110, diamonds 280, sevens 500 **plus the jackpot pool**; two cherries 1.5; any other pair 0.2. Return to player is about **94.6%** before the jackpot (tested to stay between 85% and 100%).

### Blackjack
1. `/blackjack` → **Set bet** → popup.
2. Deal (single shuffled deck stored in the session). Natural blackjacks settle immediately (3 to 2).
3. Buttons: **Hit**, **Stand**, **Double** (disabled after the first two cards). Every press updates the same message.
4. Dealer draws to 17 and stands on all 17s. Paying and deleting the session happen in one transaction, so a double click after the end pays nothing.

State: `{ bet, origBet, deck[], player[], dealer[], doubled, done, result, payout }`.

### Coin flip
Popup with bet and **Heads/Tails** dropdown → `🪙 flipping` → result. A win pays 1.95x. Buttons: **Heads again**, **Tails again**, **Change bet**.

### Fishing
**Flow**
1. `/fish` → private hub: level bar, last setup, bag value, and buttons **Cast**, **Bag**, **Shop**, **Collection**.
2. **Cast** → popup with four dropdowns built from what you own: place (only unlocked ones), rod, bait (with stock counts), tackle.
3. Submit: use one bait, roll what bit (seeded), save the fight, post it publicly:
   ```
   🏮 Lantern Bay · reeling
   ✨ Something huge is fighting back!
   [░░░░■■■■◈■░░░░░░░░░░]
   Catch   ▰▰▰▰▰▰▱▱▱▱  60%
   Tension ▰▰▱▱▱▱▱▱▱▱  20%
   [◀️ Pull] [🎣 Reel] [▶️ Pull] [✂️]
   ```
4. Each press is one step: your zone moves (pulls), the fish moves (seeded, so a step always replays the same), and the step is scored. Reeling with the fish inside the zone gains a lot of catch but builds tension. Reeling while it is outside builds tension fast and loses catch. Pulls with the fish inside gain a little and ease the tension.
5. It ends at 100% catch (caught), 0% (escaped), tension at the rod's limit (snap, bait lost), 45 seconds without a press, or 80 presses.
6. Result: the fish, its value and XP, level-ups and newly unlocked places; buttons **Cast again** (same setup), **Change setup**, **Bag**.

There is no timer on purpose. A self-updating message would hit Discord's edit limit within seconds and would not survive a reload. Each press updates the message immediately instead, which keeps the game fast.

**World**

| Place | Level | Notes |
|---|---|---|
| 🏮 Lantern Bay | 1 | start |
| 🌿 Mossmere Marsh | 5 | |
| 🧊 Rimefall Shelf | 12 | |
| 🌋 Cinder Vents | 20 | |
| 🕳️ The Hollow Deep | 30 | +3% corruption |

Each place has one fish of each rarity: **Common, Uncommon, Rare, Epic, Legendary, Mythical** (base odds 55 / 25 / 12 / 5.5 / 2 / 0.5). Luck from the rod and bait multiplies each higher tier by (1 + luck) per tier. Variants: **Mutated** (2%, ×2.5 value, ×1.3 weight), **Corrupted** (0.4% base, ×5 value), **Giant** (top 2% of weights, ×1.6 weight). Value scales with weight.

| Rod | Price | Level | Luck | Zone | Power | Line |
|---|---|---|---|---|---|---|
| Driftwood Rod | free | 1 | 0 | 5 | 11 | 100 |
| Reedspring Rod | 1,500 | 3 | +10% | 6 | 13 | 110 |
| Carbon Striker | 8,000 | 8 | +20% | 6 | 15 | 120 |
| Rimeglass Rod | 25,000 | 14 | +35% | 7 | 17 | 130 |
| Cinderspine Rod | 75,000 | 22 | +50% | 7 | 20 | 140 |
| Voidreach Rod | 250,000 | 32 | +80% | 8 | 24 | 160 |

Bait (used up, one per cast): Earthworm, Glass Shrimp, Glowgrub, Void Lure (draws corruption). Tackle (kept, one fitted per cast): Steel Leader (tension 40% slower), Lead Sinker (calmer fish), Brass Spinner (+4 per good reel), Four-Leaf Charm (mutations ×2).

Simulated with a sensible player: the starter rod lands Rare fish almost every time and Legendary about 1 in 5. The Rimeglass Rod lands Legendary about 9 in 10, and the Voidreach Rod lands nearly everything. Upgrades matter.

**Data**
```sql
games_fish_profile (guild_id, user_id, xp, casts, caught, best_weight, rods JSON, tackle JSON, last_biome, last_rod, last_bait, last_tackle)
games_fish_bait    (guild_id, user_id, bait, qty)
games_fish_bag     (id, guild_id, user_id, species, rarity, mutation, giant, weight, value, biome, caught_at, sold)
games_fish_dex     (guild_id, user_id, species, count, best_weight, first_at)
games_jackpot      (guild_id, pool)
games_stats        (guild_id, user_id, game, played, won, wagered, returned)
```

**Shop and bag:** the shop is a dropdown of what you can buy (locked rods hidden). Rods and tackle buy in one pick; bait asks *how many* in a popup. The bag can **sell all but rare finds** (keeps Legendary, Mythical and any variant) or **sell everything**.

## 4. Settings
- **Economy:** currency name and emoji, starting coins, daily base, biggest payment, join the global board.
- **Games:** each game on/off, smallest and biggest bet, jackpot start value and share of each slots bet.
