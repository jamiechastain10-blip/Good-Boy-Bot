# Good Boy on your phone

The phone app is a remote control for your bot: status, the levels leaderboard, announcements, event hubs and module switches. It talks to the dashboard on the computer that runs Good Boy, so that computer has to be on and the Good Boy app running.

## 1. Give the dashboard a link that works from anywhere (once)

In the Good Boy app: **Settings > Dashboard link > Set up**. It does each step for you and ticks it off:

1. **Install Tailscale** (free). Windows asks once to allow it: choose **Yes**.
2. **Sign in to Tailscale.** Your browser opens Tailscale's sign-in page; sign in with Google, Microsoft or GitHub.
3. **Turn on the link.** The first time, your browser opens a page to allow public links (Funnel) for your account; approve it.
4. **Add it to Discord login.** Done for you when Discord allows it. Otherwise the app shows the link with **Copy and open OAuth2**: click **Add Redirect**, paste, **Save Changes**.
5. **Pair your phone:** scan the code it shows.

The link looks like `https://your-pc.tail1234.ts.net`, never changes, and turns itself back on whenever Good Boy starts. Turn on **Keep this computer awake while the bot runs** so it keeps working when you are away.

Anyone can open the link, but only people Discord says can manage your server can do anything, same as the dashboard.

## 2a. Android

1. Install `Good-Boy-Android-<version>.apk` (allow installing from your browser or files app when Android asks).
2. Scan the code in the Good Boy app on your computer with the phone's camera, tap **Open in the Good Boy app**, then **Connect**. (Or open Good Boy and paste your dashboard link.)
3. Log in with Discord.

To switch to a different bot later: Home > **Change dashboard link**.

## 2b. iPhone

1. Scan the code in the Good Boy app on your computer with the Camera app (or open your dashboard link with `/app` on the end in Safari).
2. Log in with Discord.
3. Press **Share** > **Add to Home Screen**. Good Boy now opens like an app.

## When it says "Can't reach your bot"

- The computer is off or asleep, or the Good Boy app is closed.
- Sharing was turned off (Settings > Dashboard link).
- The phone has no internet.
