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

To run it as a container instead (e.g. on a NAS), see
[Run in Docker](#run-in-docker-ugreen-nas) below.

Slash commands register automatically (per-guild, instantly) on startup.
For a global rollout instead, run `npm run register` (propagation takes up to ~1 hour).

## Run in Docker (UGREEN NAS)

The bot is a single long-lived process with one piece of mutable state
(`data/state.json`), so the container setup is deliberately plain: build on the
NAS, bind-mount a folder for the state file, keep the token in `.env`.

### 1. Put the repo on the NAS

SSH in (UGOS: **Control Panel → Terminal & SNMP → Enable SSH**) and clone into a
share you back up:

```bash
mkdir -p /volume1/docker && cd /volume1/docker
git clone <this-repo-url> discord-counter
cd discord-counter
```

Confirm the real path with `pwd` — `/volume1` is the usual UGOS mount point, but
check rather than assume.

### 2. Configure

```bash
cp .env.example .env
vi .env            # paste your DISCORD_TOKEN
```

`.env` is gitignored and is the only place the token lives. By default the
state file lands in `./data` next to the compose file; set `DATA_PATH` in `.env`
to put it on a different share.

### 3. Build and start

```bash
docker compose up -d --build
docker compose logs -f          # expect "Logged in as <bot>#0000"
```

The image is built on the NAS, so it matches the machine's architecture
(x86_64 on the NASync DXP line) with no cross-building.

If the `data` folder ends up owned by root — Docker creates a missing bind-mount
target as root — the container refuses to start and prints the exact `chown` to
run. The container runs as uid 1000 (`node`), never root:

```bash
sudo chown -R 1000:1000 /volume1/docker/discord-counter/data
```

### 4. Keep it running

`restart: unless-stopped` covers crashes and NAS reboots. On top of that the
container reports a **healthcheck**: the bot touches a heartbeat file every 30s,
but only while its Discord gateway connection is live, so a process that is
running yet silently disconnected shows as `unhealthy` in `docker ps`. Pair it
with an auto-restart watcher if you want that state actioned automatically —
Docker itself does not restart unhealthy containers.

### Doing things to a running container

```bash
docker compose logs -f                                    # follow logs
docker compose restart                                    # restart
docker compose down                                       # stop and remove
docker compose exec discord-counter node src/diagnose.js <channelId>
git pull && docker compose up -d --build                  # update
```

Shutdown is graceful: the bot flushes its state on SIGTERM, and
`stop_grace_period: 20s` gives it room to finish.

### Using the UGOS Docker UI instead

UGOS **Docker → Project** can import this `docker-compose.yml` directly from the
cloned folder. If your UGOS build's project importer rejects the `build:` key
(some versions only accept prebuilt images), build once over SSH with
`docker compose build`, then change `build: .` to `image: discord-counter:local`
before importing — the image is already on the machine.

### Backups

Everything worth keeping is `data/state.json`. Include
`/volume1/docker/discord-counter` in a UGOS backup or snapshot job and a restore
is: clone, restore `.env` and `data/`, `docker compose up -d --build`.

### Moving existing counts over

If the bot is running somewhere else today, copy its `data/state.json` into the
NAS `data/` folder **before** the first start, then `chown 1000:1000` it. The
year-to-date counts and the `countedThrough` cursor carry over, and the startup
catch-up counts whatever was posted during the move. Skip it and the bot starts
from zero (recoverable with `/counter backfill`).

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
