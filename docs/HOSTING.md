# Reaching the dashboard from other devices (free, no domain needed)

**You only need this if people other than you, or you from another device, should open the dashboard.** On the PC that runs the bot, the dashboard already works at <http://localhost:3000> with nothing to set up (README, section 1c).

The bot keeps running on your own PC. A *tunnel* gives that PC a public `https://…` address, and Discord login then works from anywhere. Nothing below needs a domain name. Facts here were checked in October 2026 against the sources listed at the end; free plans change, so confirm on the provider's page before relying on it.

## Pick one

| | Address you get | Stays the same after a restart? | Free limits | Verdict |
|---|---|---|---|---|
| **ngrok** (free plan) | `your-name.ngrok-free.app` | **Yes** | 1 GB data/month and 20,000 requests/month; browsers see a one-click "Visit site" warning page first (remembered for 7 days) | Simplest. Fine for a few staff. |
| **Tailscale Funnel** (free Personal plan) | `your-pc.your-tailnet.ts.net` | Yes (tied to the machine's name) | Bandwidth limit exists but is not published; only ports 443, 8443, 10000 are public | No warning page, but more to set up. |
| Cloudflare *quick* tunnel | random `….trycloudflare.com` | **No: a new address every run** | no uptime guarantee, testing only | **Not usable.** Discord login needs one fixed address registered in advance. |
| Cloudflare *named* tunnel | your own domain | Yes | free, but **needs a domain** on Cloudflare | Only if you later buy a domain. |

Do **not** open a port on your router: it exposes your home network and gives you no HTTPS.

## Setup (same for every option)
1. Start the tunnel so it forwards to `http://localhost:3000` and note its public address, for example `https://good-boy.ngrok-free.app`.
   - **ngrok:** make a free account, install it, add your authtoken, and in the dashboard's *Domains* page copy your free domain and the exact command it shows (it is `ngrok http 3000` with your domain added). Leave that window open.
   - **Tailscale:** install Tailscale on the PC, in the admin console turn on **HTTPS certificates** and allow **Funnel** for this machine, then run `tailscale funnel --bg 3000`. `tailscale funnel status` prints the address.
2. In `.env` set:
   ```
   DASHBOARD_BASE_URL=https://your-public-address
   DASHBOARD_TRUST_PROXY=1
   ```
   Leave `DASHBOARD_HOST` alone (the tunnel program runs on the same PC and talks to it locally).
3. Developer Portal → your app → **OAuth2 → Redirects** → add exactly `https://your-public-address/callback` (character for character, no trailing slash).
4. Restart the bot, then open `https://your-public-address/auth/diagnose`. It shows the redirect address the bot expects and whether the Client Secret is set. It never shows the secret itself.
5. Give your moderators' role the `dashboard.access` permission (README, "Who can use it") so they get the limited view instead of nothing.

## Things to know
- **The PC must be on, with the bot and the tunnel running.** Close either and the address stops answering.
- A public address means anyone can *see the login page*. Nobody gets in without a Discord login, and what they can do is decided live from their rights in your server. Admins get everything; role holders with `dashboard.access` get only their panels; everyone else gets "no access".
- Logins last 12 hours, cookies are marked Secure on https, and every change is written to the security log (Logs page).
- Inbound webhooks (`/webhook` in the integrations module) also become reachable through the tunnel. They are rate-limited and use long secret URLs, but turn the tunnel off when you do not need it.
- Keep `DASHBOARD_TRUST_PROXY=1` **only** for a tunnel you run yourself. It tells the dashboard to believe the host name the tunnel reports.
- Reset your Discord **Client Secret** (Developer Portal → OAuth2) if you ever pasted it anywhere public, and put the new one only in `.env`.

## Sources checked
- ngrok free plan limits: <https://ngrok.com/docs/pricing-limits/free-plan-limits> (one static `*.ngrok-free.app` domain that survives restarts; 1 GB/month; 20,000 HTTP requests/month; interstitial page).
- Cloudflare Quick Tunnels: <https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/> (no account or domain needed, but the hostname changes every time; for testing only).
- Tailscale Funnel: <https://www.ssdnodes.com/learn/tailscale-funnel-limits-and-ports> (ports 443, 8443, 10000; unpublished bandwidth limits; `*.ts.net` names) and <https://devtoolpicks.com/blog/when-to-use-cloudflare-tunnel-vs-tailscale-funnel-vs-public-vps-indie-hackers-2026> (Funnel on the free Personal plan; Cloudflare Tunnel is paired with owning a domain). I could not open Tailscale's own documentation from where this was written, so check <https://tailscale.com/kb/1223/funnel> for the current steps.
