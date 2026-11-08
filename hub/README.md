# Good Boy hub

A tiny service that lets Good Boy bots find each other, so the server switcher in the dashboard and the phone app can
show servers that are run by someone else's Good Boy bot. It keeps only each bot's application ID, the IDs of the
servers it is in, its dashboard link and a public key. No member, role or message data.

## Put it online (free)

1. Make a free account at https://dash.cloudflare.com.
2. Install Wrangler, Cloudflare's tool: `npm install -g wrangler`, then `wrangler login`.
3. In this folder, make the storage: `wrangler kv namespace create HUB`. Copy the `id` it prints into `wrangler.toml`.
4. Publish: `wrangler deploy`. It prints the hub's link, like `https://goodboy-hub.<your-name>.workers.dev`.
5. Put that link in Good Boy as `GOODBOY_HUB_URL` (the bot's `.env`), and restart the bot.

Cloudflare's free plan covers 100,000 requests a day, far more than the hub needs.

## Turning it off

Set `GOODBOY_HUB=off` in a bot's `.env`. That bot leaves the hub and stops showing up in other people's switchers.
