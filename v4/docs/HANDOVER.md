# How every Good Boy 3 app gets Good Boy 4, with its data

Two promises: every installed Good Boy 3 app can find, download and move to v4, and nothing is lost on the way.

## What a Good Boy 3 install has

| Thing | Where (Windows) | How v4 gets it |
|---|---|---|
| Server data: levels, coins, tickets, playlists, settings, permissions | `%APPDATA%\Good Boy\bot-data\eclipse.db` | Copied with SQLite's own backup (`gb-data::import_3x`). **Built and tested.** |
| Your own art, uploads, other module files | `%APPDATA%\Good Boy\bot-data\...` | Copied with the database. **Built and tested.** |
| Bot token and client secret | `%APPDATA%\Good Boy\secrets.bin`, encrypted by Windows for this user through the 3.x app | Handed over by the 3.x app itself (see step 3). Not built. |
| App settings: start with Windows, dashboard link, appearance | `%APPDATA%\Good Boy\settings.json` | Read by the v4 launcher on first run. Not built. |
| Licence key | `settings.json` | Read and re-checked with the same public key. Not built. |

The Developer and Owner editions keep the same things under `Good Boy Developer` and `Good Boy Owner`.
`gb-data::find_3x_data` finds all three and puts the most recently used first.

## The route: one last 3.x update, the "bridge"

Installed Good Boy 3 apps already update themselves from the public release feed. So the way to reach every
one of them is one more ordinary 3.x update. That update adds a hand-over step and nothing else.

1. **The bridge update ships** as a normal 3.x release. Every installed app takes it the usual way.
   Portable, Mac and Owner copies show the "new version" notice with a download button, as they do today.
2. **The bridge waits.** It looks for a v4 entry in the release feed. Until one is there it does nothing new.
   This means the bridge can ship early and sit quietly until v4 is ready.
3. **When v4 is published**, the bridge:
   - downloads the v4 launcher and checks its SHA-512 against the feed, the same check updates use today;
   - stops the bot cleanly;
   - runs the v4 launcher in "move in" mode, passing the token and client secret to it directly, in memory,
     never as a file on disk or a command-line argument. The v4 launcher stores them with Windows' own
     credential store;
   - the v4 launcher copies the data (`import_3x`), reads the app settings and licence, starts the v4 bot and
     shows a "your data came across" screen with the counts from `Summary`.
4. **Good Boy 3 stays installed and untouched** until the owner removes it from the v4 launcher. If anything
   goes wrong in step 3, the bridge starts the 3.x bot again and reports why. Nothing was changed, so nothing
   needs undoing.

## Safety rules

- The 3.x data folder is never written to. Tested: the file is byte-for-byte the same after an import.
- An import never overwrites data v4 already has. Tested.
- The copy is checked (`PRAGMA integrity_check`) before it becomes v4's database. A copy that fails is deleted.
- A database from a newer Good Boy than the launcher understands is refused, not guessed at. Tested.
- v4 marks where its data came from in its own `v4_meta` table. It adds no columns to 3.x tables.

## Still to decide or check

- Smart App Control blocks unsigned installers, and the v4 launcher is a new program. Without signing, the
  hand-over in step 3 can be blocked on PCs that have it on. Signing matters more here than for a 3.x update.
- The exact way the token is passed in step 3 on macOS (Keychain) needs its own design.
- Whether the v4 launcher uses the same install location as the 3.x app or sits beside it. Beside it is the
  safer start, because going back stays possible.
