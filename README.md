# discord-counter

A Discord bot that tracks how often an **emoji string** appears in a channel and
keeps a live tally in the **channel topic**:

```
🎉 · 42 in 2026 · last seen 3 days ago
```

- **Year-to-date count** of occurrences (resets automatically each new year)
- **Days since last seen**
- The tracked emoji string itself

It counts every _occurrence_ (so `🎉🎉🎉` in one message counts as 3) and works
for both unicode emoji (`🎉`) and custom Discord emoji (`<:party:123>`).
Multi-emoji strings tolerate whitespace between the emoji: Discord's desktop
emoji picker and `:autocomplete:` insert a space after each emoji, so `🐿️ 💀`
counts as `🐿️💀`. Order still matters, and plain text is matched exactly.

## How it works

- A live listener increments a persisted per-channel count as messages arrive.
- Messages posted in a channel's **threads** count toward that channel (the
  topic lives on the parent, not the thread). Backfill walks active threads and
  any archived this year too.
- On startup the bot re-walks each tracked channel from where its count left
  off, so anything posted while it was down is added. (That channel's live
  messages are held for the few seconds the walk takes, then counted.)
- Stats are written to the channel topic through a **throttled updater**.
  Discord limits channel-topic edits to ~2 per 10 minutes per channel, so the
  bot coalesces rapid sightings and also refreshes on a timer (default hourly)
  so "days since last seen" stays current.
- State lives in `data/state.json` and survives restarts. Deleting it means
  the next start only counts from that moment on; run `/counter backfill` to
  rebuild the year.

## Setup

### 1. Create the bot application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Open the **Bot** tab → **Reset Token** → copy the token.
3. On the same **Bot** tab, enable the **Message Content Intent** (privileged).
   The bot needs it to read message text and count emoji. Without it the count
   stays at zero.

### 2. Invite the bot with the right permissions

On the **OAuth2 → URL Generator** tab, select scope **`bot`** and permissions:

- **View Channel**
- **Read Message History** (needed for `/counter backfill`)
- **Manage Channels** (needed to edit the channel topic)
- **Manage Threads** (optional: lets `/counter backfill` see private archived
  threads the bot hasn't joined)

Open the generated URL to add the bot to your server.

### 3. Configure and run

```bash
cp .env.example .env      # then paste your token into .env
npm install
npm start
```

To run it as a container on a NAS instead, see
[Install on a UGREEN NAS](#install-on-a-ugreen-nas-docker-app-no-ssh) below —
that path needs no shell on the NAS and no local build.

Slash commands register automatically (per-guild, instantly) on startup.
For a global rollout instead, run `npm run register` (propagation takes up to ~1 hour).

## Install on a UGREEN NAS (Docker app, no SSH)

This walkthrough assumes nothing. You will not need a command line, and you
will not need to know anything about Docker.

**One bit of vocabulary, then no more jargon.** An *image* is a frozen ready
meal: the bot, packaged up, sitting on a shelf on the internet. A *container*
is that meal actually cooking on your NAS. You are about to take the frozen
meal off the shelf and start cooking it.

Here is the whole plan, four steps:

1. Make an empty folder on the NAS, for the bot to remember things in.
2. Paste a small block of settings into the Docker app.
3. Check it started.
4. Tell the bot what to count, in Discord.

Every push to `main` publishes a ready-built image, so your NAS only downloads
it. It never has to build anything.

### One thing to avoid

In the Docker app there is an **Image** section with an **Image Database**
tab. It is tempting, and it is a dead end for us. That tab only searches
Docker Hub, and this bot lives on GitHub's registry instead, so searching for
it there finds nothing and there is nowhere to type its full address.

Use the **Project** section instead. It can fetch the bot by its full address.
That is the only route these instructions use.

### Before you start

Have these three ready, or the later steps will stall:

- **Your bot token.** The long secret string from steps 1–2 near the top of
  this README. Copy it somewhere you can paste from.
- **Message Content Intent turned on**, on the Developer Portal's Bot tab.
  This one catches people out: without it the bot starts perfectly, looks
  online, and counts nothing at all, forever.
- **The bot invited to your server**, with the permissions listed in step 2.

### Step 1 — Make a folder for the bot's memory

The bot keeps one small file with your counts in it. It needs somewhere on the
NAS to keep that file. If you skip this, the counts are wiped every time the
bot is updated or recreated.

1. Open **File Manager** on the NAS.
2. Pick a shared folder that gets backed up. If nothing fits, make one called
   `docker`.
3. Inside it, make a folder called `discord-counter`.
4. Inside *that*, make a folder called `data`.
5. Write down the full path. It usually looks like
   `/volume1/docker/discord-counter/data`. Check it in File Manager rather
   than trusting that example — you need it exactly right in the next step.

Leave the folder empty. **Do not change its permissions.** Normally you would
have to, and normally that needs a command line. This bot fixes its own
folder permissions when it starts, which is precisely why you can install it
without one.

### Step 2 — Paste the settings into a project

1. In the Docker app, open **Project** and create a new project.
2. Name it `discord-counter`.
3. When it asks for the compose file — a text box, or an offer to create
   `docker-compose.yml` — paste this in, all of it:

```yaml
services:
  discord-counter:
    image: ghcr.io/pleasesavemycat/discord-counter:latest
    container_name: discord-counter
    restart: unless-stopped
    init: true
    stop_grace_period: 20s
    environment:
      DISCORD_TOKEN: "paste-your-token-here"
      TZ: "America/Los_Angeles"
    volumes:
      - /volume1/docker/discord-counter/data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Now change exactly two things, and nothing else:

- **The token.** Replace `paste-your-token-here` with your bot token. Keep the
  quote marks around it.
- **The folder.** In the `volumes:` line, replace the part *before* the colon
  with your folder from step 1. The `:/app/data` part *after* the colon must
  stay exactly as it is — that is the folder name inside the container, not on
  your NAS, and the bot looks for that exact name.

Then build/start the project. It downloads the bot (about 61 MB) and starts
it.

You do not need to set up any ports. The bot phones out to Discord; nothing
ever connects to it.

Anyone who can read that project folder can read your token, so keep the
folder private.

**Optional settings**, if you ever want them — add them under `environment:`
in the same style:

| Setting | Default | What it does |
| --- | --- | --- |
| `TZ` | `UTC` | Timezone for log timestamps. The yearly count rollover is always UTC regardless. |
| `TOPIC_REFRESH_MINUTES` | `60` | How often "days since last seen" is refreshed. |
| `TOPIC_MIN_INTERVAL_SECONDS` | `300` | Smallest gap between topic edits. 300 is the safe floor. |
| `PUID` / `PGID` | `1000` | Who owns the memory file, if it has to be a particular NAS user. |

### Step 3 — Check that it started

Open the container and look at its **log**. Within a few seconds you want to
see a line like:

```
Logged in as YourBot#1234
```

That is success — the bot is connected. After a minute or two the Docker app
also shows a health status for it, which should settle on **healthy**.

If you see something else, jump to "If something goes wrong" below.

### Step 4 — Tell it what to count

The bot is running, but it is not watching anything yet. Go to the Discord
channel you want counted and type:

1. `/counter set string:🎉` — using whatever emoji you are tracking. The
   channel topic changes within a few seconds.
2. `/counter backfill` — this reads back through the channel's history so the
   year-to-date number reflects what was already posted. In a busy channel it
   takes a while; it tells you when it is finished.

Now post the emoji somewhere in the channel to try it.

**One thing that looks broken but isn't:** after that first change, the topic
only updates **once every five minutes at most**. Discord refuses more than
about two topic edits per ten minutes, so the bot waits on purpose. Your count
is recorded the instant the message arrives — it is only the display that
lags. `/counter show` always tells you the true number immediately.

### If something goes wrong

Look at the container's log first. The bot is built to fail loudly with the
reason, rather than quietly carrying on broken.

| What you see | What it means |
| --- | --- |
| `cannot write to /app/data` | The folder line is wrong, or that folder is read-only. Check the part after the colon is exactly `/app/data`. |
| `Missing DISCORD_TOKEN` | The token line is missing, misspelled, or still says `paste-your-token-here`. |
| The bot is online, but the count never moves | **Message Content Intent** is off. Turn it on, then restart the container. |
| `/counter show` gives the right number, but the topic never changes | The bot doesn't have **Manage Channels** permission in that channel. |
| `Failed to set topic` | Same as above — or it's a kind of channel that has no topic. |
| It keeps restarting over and over | Copy the last 20 lines of the log and ask; something is wrong at startup. |

### Updating it later

In the Docker app, tell the project to pull the newer image and recreate
itself (the wording varies — "pull and rebuild", "recreate"). Your counts live
in the folder from step 1, so they come through untouched.

Every build also gets a tag naming its exact version, like `sha-abc1234`. If a
new version ever misbehaves, change `:latest` in the compose file to an older
tag to go back.

### Where to look for things

- **Logs**: the container's log tab.
- **Health**: the bot writes a small "still alive" note every 30 seconds, but
  *only while its Discord connection is actually up*. So a bot that is running
  yet quietly disconnected shows as `unhealthy` instead of pretending to be
  fine. Worth knowing: Docker does not restart unhealthy containers by itself.
  Auto-restart only kicks in when a container fully stops.
- **The diagnose tool**, if a count ever looks wrong: open the container's
  terminal/console tab and run `node src/diagnose.js <channelId>`. It only
  reads; it changes nothing.

### Backing it up

The only thing worth keeping is the single `state.json` file in the folder
from step 1. Include that folder in a UGOS backup or snapshot job and you are
covered.

### If the bot already runs somewhere else

Copy its existing `data/state.json` into your new folder **before** starting
the container for the first time — File Manager can upload it. Your
year-to-date counts carry over, and the bot counts anything posted during the
move as it starts up.

Skip this and it begins from zero, which `/counter backfill` can repair.

## Run in Docker from the command line

If you do have a shell (another host, or SSH on the NAS):

```bash
cp .env.example .env         # paste your token
docker compose up -d         # pulls the published image
docker compose logs -f
```

`docker-compose.yml` reads `DISCORD_TOKEN`, `DATA_PATH`, `TZ` and friends from
that `.env`. Uncomment `build: .` in it to build from the checkout instead of
pulling, and update with `docker compose pull && docker compose up -d`.

## Usage

Run these in the channel you want to track (run from inside a thread, they
apply to the thread's parent channel):

| Command | Who | What it does |
| --- | --- | --- |
| `/counter set string:🎉` | Manage Channels | Start counting that string in this channel |
| `/counter backfill` | Manage Channels | Scan channel history to seed the year-to-date count |
| `/counter show` | Anyone | Show current stats (ephemeral) |
| `/counter clear` | Manage Channels | Stop tracking this channel |

Typical first-time flow: `/counter set string:🎉` then `/counter backfill` to
make the year-to-date figure accurate from existing history.

## Notes & limitations

- Counting happens on **new messages** only; edited or deleted messages after
  the fact are not adjusted (re-run `/counter backfill` to recompute exactly).
- `TOPIC_REFRESH_MINUTES` in `.env` controls the "days since" refresh cadence.
  Keep it well above 5 minutes to respect Discord's channel-edit rate limit.
- Years are computed in UTC. The container's `TZ` only affects log timestamps.
- In Docker, `DATA_DIR` overrides where `state.json` is written (set to
  `/app/data` in the image); unset, it stays the repo's `data/` folder.
- The container starts as root only to fix the mounted folder's ownership,
  then runs the bot as `PUID:PGID` (1000:1000 by default). Set `user:`
  yourself to skip the root phase entirely, and the folder must already be
  writable by that user.
