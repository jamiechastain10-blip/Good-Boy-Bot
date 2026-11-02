# Good Boy 3.0 plan: Good Boy Clipper

A small Windows app for members (separate from the app that runs the bot) that clips games and sends them to Discord
through Good Boy, so the server no longer needs Medal. Built in stages; each stage is a release members install and test
in real games, because clipping can only be proven on real gaming PCs.

## How members use it
1. Install, sign in with Discord once.
2. It sits in the tray and keeps the last 30 seconds of screen and game sound.
3. Press the hotkey (Alt+F10, changeable), or let auto clips catch the moment.
4. Preview, trim, add a title, press **Send**. Nothing is uploaded until they do.
5. Good Boy posts it in the clips channel as "clip by @member": votes, Best clips, clip of the week and coins as usual.

## Stages
| Stage | What's in it |
|---|---|
| 1 | Hotkey clipping, game sound, Discord sign-in, send to the clips channel through the bot, clip loudness evened out, clips shrunk to fit Discord's 10 MB limit |
| 2 | Preview and trim, title, clip length (15/30/60 s), optional mic, clip library, automatic game tags, "Clipping with Good Boy" Rich Presence |
| 3 | Auto clips: CS2 and Dota 2 (Valve Game State Integration), League of Legends (Riot Live Client Data API), hype detection (loud moments, voices, reactions) for every other game. Auto clips stay in the app until the member sends one |
| 4 | Discord in the app (through the bot): the clips feed, voting, notifications (votes, Best clips, clip of the week), send to any channel, see who from the server is in voice or playing the same game |
| 5 | Live audio balancing (game turned down while friends talk in Discord), clip editor (trim, slow motion, text), screenshots hotkey, weekly highlight reel made by the bot, full-quality clips hosted on the bot's computer (no 10 MB limit), storage clean-up |

## Known limits
- Windows first. Uses Windows' own screen capture (the same as Discord screen share); a few games with strict anti-cheat or
  exclusive fullscreen may record black, borderless windowed usually fixes it.
- No official kill feed for Valorant, Fortnite, Apex and others: hype detection only there.
- Discord does not let apps control the Discord client (mute, join voice) without special approval.
- Sending clips needs the owner's dashboard link to be set up (the same link testers use).
