# Good Boy hub

The official hub is online at **https://goodboyhub.pages.dev** and is built into Good Boy, so bots join it by themselves.
The steps below are only for running your own.

The hub does two things:

1. **The one dashboard link.** Its address is a dashboard home page like other bots have: people sign in with Discord,
   see every server they're in that runs a Good Boy bot, and **Manage** opens that bot's dashboard on that server.
2. **Bots finding each other**, so the server switcher in every dashboard and the phone app can show servers run by
   your other Good Boy bots.

It keeps only each bot's application ID, the IDs of the servers it is in, its dashboard link and a public key, plus a
signed-in person's name, picture and server list for 7 days. No member, role or message data.

## Put it online (free, about 10 minutes)

1. Make a free account at https://dash.cloudflare.com.
2. Install Wrangler, Cloudflare's tool, and sign in:
   `npm install -g wrangler`, then `wrangler login`.
3. In this folder, make the storage: `wrangler kv namespace create HUB`. Copy the `id` it prints into `wrangler.toml`.
4. Publish: `wrangler deploy`. It prints the hub's link, like `https://goodboy-hub.<your-name>.workers.dev`.

### Sign in with Discord (for the one dashboard link)

5. Open https://discord.com/developers/applications and pick your main bot (any of your bots works).
6. **OAuth2** → **Redirects** → **Add Redirect**: `https://goodboy-hub.<your-name>.workers.dev/callback`, then **Save Changes**.
7. Copy the **Client ID** and the **Client Secret** from that page, then in this folder run:
   `wrangler secret put DISCORD_CLIENT_ID` (paste the ID), then
   `wrangler secret put DISCORD_CLIENT_SECRET` (paste the secret).

Open the hub's link: you should see **Sign in with Discord**.

### Bots join the hub

8. Built in: the hub's link is set as `DEFAULT_HUB_URL` in `src/hub.js`, so every Good Boy bot joins by itself.
   Otherwise put it in a bot's `.env` as `GOODBOY_HUB_URL` and restart.
9. A bot only joins once its dashboard has a public link (Windows app: **Settings → Dashboard link**), because nobody
   else could open it otherwise.

Cloudflare's free plan covers 100,000 requests a day, far more than the hub needs.

## Turning it off

Set `GOODBOY_HUB=off` in a bot's `.env`. That bot leaves the hub and stops showing up in other people's switchers and
on the one dashboard link.
