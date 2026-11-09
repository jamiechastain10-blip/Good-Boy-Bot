# Your own art for roleplay and critters

Good Boy draws its own roleplay animations and critter pictures. You can replace any of them with your own pictures
or GIFs. Your art is used in **every server** the bot is in. Only the person who runs the bot can change it.

## Two ways to add art
**In Discord:** `/art add` opens a form: pick *Roleplay action* or *Critter*, type the name, attach the picture or GIF.
`/art list` shows what you have replaced and every name. `/art remove` puts the built-in look back.

**By copying files** (handy for lots at once) on the computer that runs the bot:

```
data/art/rp/hug/                     one or more pictures or GIFs for /rp hug (one is picked at random each time)
data/art/rp/bonk/
data/art/critters/emberpup/          Emberpup's picture
data/art/critters/emberpup-sparkly/  the Sparkly Emberpup (if empty, the normal picture is used)
```

Any file names work. PNG, JPG, GIF or WEBP, up to 8 MB each, up to 20 per name. Changes show straight away, with no
restart.

## What's used
1. Your art, if there is any for that name.
2. For roleplay: Tenor GIFs, if the bot owner set up a Tenor key.
3. Good Boy's built-in art.

A server can still switch pictures off with roleplay's "Show Good Boy's own animations" setting.

## Tips
- Critter pictures look best square, around 320 by 320 pixels or larger.
- Roleplay GIFs look best around 400 pixels wide or larger.
- Only use art you made or have the right to use.
- Moving the bot to another computer? Copy the `data/art` folder too: the data export file holds the database only.

## Every name
**Roleplay actions:** hug, cuddle, kiss, handhold, highfive, pat, boop, poke, tickle, feed, bonk, slap, bite, wave, dance, cry, blush, smile, laugh, sleep

**Critters:** emberpup, cindermouse, flarefin, blazeback, pyrohorn, infernyx, puddlepaw, bubblet, tidewhisk, coralcrest, riptusk, abyssqua, sproutle, mossnub, thornip, bloomtail, barkbeast, verdantis, zapling, voltpup, fizzlet, staticoon, thunderhorn, fulgarix, pebblit, rubblebun, cragjaw, boulderback, geodrake, titanyx, snowpip, frostkit, icicub, glacipaw, blizzhorn, cryonix, duskit, gloomoth, shadeling, nightfang, umbrax, phantomaw, puffwing, breezlet, gustkit, cloudmane, stormtalon, aerolux, solarion, lunaris, terravore, tempestra. Add `-sparkly` to any of them for its Sparkly version (for example `emberpup-sparkly`).
