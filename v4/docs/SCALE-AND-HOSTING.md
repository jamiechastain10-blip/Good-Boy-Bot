# Two v4 requirements: big servers and web hosting

## Ready for servers with 5,000 members and more

What "ready" means, and where each part stands.

| Area | The rule | State |
|---|---|---|
| Leaderboards and `/rank` | Never read every member. The database keeps each server's members in XP order (`v4_idx_xp`), so the top 10 and one member's place are index look-ups. | **Built and tested** with 6,000 and 60,000 members (`tests/big_servers.rs`) |
| Every other board (coins, messages, voice, fish, clips) | The same: an ordered index per board, never a full read. | Not built |
| Each message | One pass through the modules that are on. Settings are held in memory and refreshed when they change, so a message never waits on the database for settings. | Not built |
| Word checks (AutoMod, highlights, scam links) | One combined matcher per server, rebuilt when its lists change. | Not built |
| Member list | Keep only what is needed in memory, not every member's full record. | Not built |
| Pictures (rank cards and so on) | Drawn on background threads. Unchanged pictures are reused. | Not built |
| Discord's rate limits | One queue per kind of action, so a burst (a raid, a mass role change) is spread out, not dropped. | Not built |
| Dashboard lists | Always paged and searched in the database, never sent whole. | Not built |
| Proof | A standing load test: a pretend server with 5,000, 25,000 and 100,000 members and a stream of messages, run on every change, with limits it must stay inside. | Started (the leaderboard part) |

Measured so far, on the development machine, release build:

| Members | Read everyone and sort (the 3.x way) | Top 10 | One member's place |
|---|---|---|---|
| 6,000 | about 10 ms | about 0.1 ms | about 1 ms |
| 60,000 | about 100 ms | about 0.5 ms | about 11 ms |

## Web hosting as a choice in setup

The launcher's first run asks where the bot should live.

| Choice | What happens |
|---|---|
| **On this computer** | As today. The bot runs while the PC is on. |
| **On a web host** | The bot runs on a server you rent, so it stays online when your PC is off. The launcher becomes its remote control. |

How the web host choice works:

1. The launcher shows one command to paste on the server (or a Docker option). It installs the bot as a service
   that starts by itself and restarts if it stops. v4 is one small program, so there is nothing else to install.
2. The server shows a short pairing code. Typing it into the launcher links the two.
3. The launcher sends the data up: the same safe copy as `import_3x`, checked on arrival.
4. From then on the launcher, the website and the phone all talk to the hosted bot. Updates are installed on the
   server from the launcher, at the hours the owner allows.
5. **Move back or move hosts** at any time: the launcher pulls the data down, or sends it to a new server.

Rules:

- The bot token is sent to the server once, over an encrypted link, and stored there with the server's own
  protection. It is never shown again in the launcher.
- The server only accepts the paired launcher and signed-in dashboard users. Pairing codes are single-use and
  expire in minutes.
- The dashboard on a host gets a real web address with HTTPS, so it no longer depends on a home PC's link.
- Nothing is hosted by Basic Ghost Labs. The owner picks and pays for the host. The launcher can suggest sizes:
  the smallest plan a host sells is enough for most servers, and the Performance page says when to go bigger.

Still to decide: which hosts get a step-by-step guide first, and whether music playback needs a larger plan
(it uses one ffmpeg process per server that is playing).
