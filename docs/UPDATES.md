# Updates

Good Boy can update itself, but only when **you** turn it on, only from releases **you** signed, and only when started through the supervisor. Nothing is installed without a click in the dashboard (or a command you type).

Status: built and tested in a sandbox (real child processes, a local web server, the real command line). **Not yet tried against a real hosting site or on Windows.** Do a dry run with a throwaway release before relying on it.

## How it works

- `npm run supervised` starts a small watcher (the supervisor) that runs the bot, restarts it if it crashes (with growing pauses, and gives up with a clear message after repeated crashes), and performs updates.
- Releases live in `releases/<version>/` beside your data. Your `.env` and `data/` are never part of a release and are never touched.
- An update is **downloaded, checked (size + sha256 + signature), unpacked safely, your database is backed up, then the bot is switched over**. The new version must report "ready" within the health timeout, otherwise it is **rolled back automatically** and that version is remembered as bad.
- A release that needs new npm packages is downloaded but **never applied**; the dashboard tells you to run `npm install` yourself first.
- Only the bot owner (the Discord application owner) can see or use the Updates page.

## One-time setup (on the computer you publish from)

1. `npm run release:keygen -- <folder outside the project>`  
   Writes `release-private.pem` into that folder (**keep it secret and backed up**) and `update-public-key.pem` into the project.
2. Put `update-public-key.pem` next to `.env` on every computer that runs the bot.
3. Pick somewhere to host two files over **https** (GitHub Releases, GitHub Pages, any web host). Loopback `http://127.0.0.1` is allowed for testing.

## Publishing a release

1. Bump `version` in `package.json`.
2. `npm run release -- --key <path>/release-private.pem --channel stable --notes "what changed"`
3. Upload `dist/good-boy-<version>.tar.gz` and `dist/latest.json` to the same web folder.

Running it again for another channel (`beta`, `development`) keeps the others in the manifest. `stable` only sees stable; `beta` also sees stable; `development` sees everything. Prereleases (for example `2.1.2-rc.1`) cannot be published to stable.

## Turning it on (on the bot's computer)

In `.env`:

```
UPDATE_MANIFEST_URL=https://your.host/good-boy/latest.json
UPDATE_CHANNEL=stable
UPDATE_CHECK_HOURS=12
```

Then start with `npm run supervised`. Without the URL **or** without the public key, updates stay off.

## Using it

- Dashboard → **Updates** (bot owner only): check, then install (two clicks).
- Command line: `npm run update -- status | check | install | rollback`.
- Rollback goes back to the previous version; if there is none, to the code in the folder itself.

## Limits (honest)

- Automatic installing without a click is **not built**.
- Not run on Windows yet; the folder-link step (`node_modules`) and stop signals behave differently there.
- The signature protects you from a tampered download or a hacked host. It does **not** protect you if the private key leaks, so keep it off the bot's computer and out of the project.
