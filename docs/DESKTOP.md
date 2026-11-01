# Desktop app (Windows and macOS)

**Status: built by GitHub Actions (`.github/workflows/desktop.yml`).** Each build makes the Windows installer, a portable `.exe` and the Mac `.dmg` files. The Windows build then starts the built app and checks that the launch window and the main window really drew, with the glass look. It fails the build if not, and saves screenshots as the `smoke-windows` artifact. Not yet checked: starting and stopping a real bot from the app, the tray icon, and the Mac app on a real Mac (it is built but not started by the check). The `.exe` is not code-signed, so Windows SmartScreen warns on first run (More info > Run anyway).

**Getting the files:** GitHub > the repo > Actions > "Desktop app" > the latest green run > Artifacts (`Good-Boy-Windows`, `Good-Boy-Mac`). To rebuild by hand: Actions > Desktop app > Run workflow.

## What it is

A small control panel that sits next to a normal Good Boy folder on the same computer. It does not replace the bot or bundle it.

- Start, stop and restart the bot (through the supervisor, so crash-restarts and updates keep working).
- Shows status and the live log (tokens and secrets are removed from the log before it is shown).
- Tray icon (Windows) / menu-bar icon (macOS) with Open, Open dashboard, Start/Stop, Quit.
- Options: start the bot when the app opens, open the app when you sign in, and what the window's X does (keep running in the tray, or quit and stop the bot). Single instance only.
- "Open dashboard" opens `http://localhost:<port>` in your normal browser. Nothing else can be opened from the app.

## Decisions

- **Electron over Tauri.** The bot is Node, and the app launches it with the computer's own Node, so there is no second toolchain (Tauri needs Rust). The cost is a bigger download (~100 MB).
- **Uses your installed Node (22.13+), not Electron's.** The bot needs `node:sqlite`, and I could not verify it inside Electron's bundled Node. The app checks Node and says so plainly if it is missing or too old.
- **No token storage in the app.** The token stays in the bot folder's `.env`, exactly as with `npm start`. The app only checks that a `DISCORD_TOKEN` line exists and never shows it.
- **Stops by message, not by signal.** Windows cannot stop a child politely with signals, so the app sends a shutdown message the supervisor understands. If the app is killed, the supervisor and bot stop too (tested on Linux).
- **Not signed.** macOS will warn "unidentified developer" (right-click → Open the first time); Windows SmartScreen may warn too. Signing needs paid certificates and is not set up.

## Building it

You need Node 22.13+ and, for the Mac app, a Mac (a `.dmg` cannot be built on Windows).

```
cd desktop
npm install
npm start            # run it for real (also copies the shared styles)
npm run dist:win     # Windows installer and portable .exe  -> desktop/dist
npm run dist:mac     # macOS .dmg (run on a Mac)            -> desktop/dist
```

First run: press **Choose folder…** and pick your Good Boy folder. It must already have `npm install` done and a `.env` with the token.

## Known gaps

- Installer icon: electron-builder needs a 512×512+ PNG (`desktop/build/icon.png`); the logo in the project is 256×256, so builds use the default icon until you supply one.
- Not tested: the window, tray, start-at-login, close-to-tray, single instance, or any build, on either OS.
- Not built: bundling the bot inside the app, updating the app itself, a first-run wizard that creates `.env`, Minecraft launcher / server manager pieces.
- Keep `desktop/renderer/glass.css` in step with the dashboard (`npm run sync` in `desktop/`); a test fails if they drift.
