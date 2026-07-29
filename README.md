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

## How it works

- A live listener increments a persisted per-channel count as messages arrive.
- Stats are written to the channel topic through a **throttled updater**.
  Discord limits channel-topic edits to ~2 per 10 minutes per channel, so the
  bot coalesces rapid sightings and also refreshes on a timer (default hourly)
  so "days since last seen" stays current.
- State lives in `data/state.json` and survives restarts.

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

Open the generated URL to add the bot to your server.

### 3. Configure and run

```bash
cp .env.example .env      # then paste your token into .env
npm install
npm start
```

Slash commands register automatically (per-guild, instantly) on startup.
For a global rollout instead, run `npm run register` (propagation takes up to ~1 hour).

## Usage

Run these in the channel you want to track:

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
- Years are computed in UTC.
