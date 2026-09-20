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

Every push to `main` publishes a ready-built `linux/amd64` image to
`ghcr.io/pleasesavemycat/discord-counter:latest`, so the NAS only pulls — it
never builds, and you never need a shell on it.

### 1. Pull the image

In the UGOS **Docker** app, open the image/registry section, search for or
enter:

```
ghcr.io/pleasesavemycat/discord-counter
```

and pull the `latest` tag. The package is public, so no registry account or
credentials are needed. (Menu labels move around between UGOS versions; the
step is "pull an image by name from a registry", wherever your build puts it.)

### 2. Create a folder for the state file

In **File Manager**, make a folder for `state.json` to live in — e.g.
`docker/discord-counter/data` inside a share you back up. It only ever holds
one small JSON file.

You do **not** need to set its permissions. The container starts as root just
long enough to take ownership of that folder, then drops to an unprivileged
user (uid 1000 by default) for everything else — which is the whole reason a
UI-only install works without a shell.

### 3. Create the container

Launch a container from the pulled image with:

**Volume / folder mapping**

| Host folder | Mount path |
| --- | --- |
| the folder from step 2 | `/app/data` |

**Environment variables**

| Variable | Value |
| --- | --- |
| `DISCORD_TOKEN` | your bot token (required) |
| `TZ` | e.g. `America/Los_Angeles` (optional — log timestamps only) |
| `TOPIC_REFRESH_MINUTES` | `60` (optional) |
| `TOPIC_MIN_INTERVAL_SECONDS` | `300` (optional) |
| `PUID` / `PGID` | `1000` (optional — only to own the state file as a specific NAS user) |

**Other settings**

- Enable **auto-restart** so the bot survives crashes and NAS reboots.
- No port mappings. The bot makes an outbound connection to Discord and
  listens on nothing.

Start it, then open the container's log. `Logged in as <bot>#0000` means it's
running; go set it up with `/counter set` in Discord.

### Faster alternative: paste a compose project

If your Docker app has a **Project** (compose) section, skip steps 1–3 and
paste this, with your own token and folder path — it captures every setting at
once:

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
      TZ: "UTC"
    volumes:
      - /volume1/docker/discord-counter/data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Your token sits in that project file on the NAS, so treat the project folder as
a secret. Check the host path against what File Manager shows for your share —
`/volume1` is the usual UGOS mount point, but confirm rather than assume.

### Updating

Pull `ghcr.io/pleasesavemycat/discord-counter:latest` again in the Docker app,
then recreate the container from the new image, keeping the same folder mapping
and environment variables. The state file is on the mounted folder, so counts
survive. For a compose project, "pull and rebuild/recreate" does both.

Every build is also tagged with its commit (`sha-abc1234`), so you can pin to a
specific one, or roll back by recreating the container from an older tag.

### Health and logs

- **Logs** are in the Docker app's log tab for the container.
- **Health**: the container reports healthy/unhealthy on its own. The bot has
  no HTTP surface, so liveness is a heartbeat it writes every 30s *only while
  its Discord connection is live* — a bot that is running but silently
  disconnected shows as `unhealthy` rather than looking fine. Note that Docker
  does not restart unhealthy containers by itself; auto-restart only covers a
  container that actually exits.
- **Running `diagnose`**: use the container's terminal/console tab in the
  Docker app and run `node src/diagnose.js <channelId>`.

### Backups

Everything worth keeping is the one `state.json` in the folder you mapped.
Include it in a UGOS backup or snapshot job.

### Moving existing counts over

If the bot runs somewhere else today, copy its `data/state.json` into the
mapped folder (File Manager can upload it) **before** starting the container.
Year-to-date counts and the backfill cursor carry over, and the startup
catch-up counts anything posted during the move. Skip it and the bot starts
from zero, recoverable with `/counter backfill`.

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
