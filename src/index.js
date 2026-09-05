import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
} from "discord.js";

import {
  loadState,
  flushState,
  saveState,
  getChannel,
  getTrackedChannels,
  setTracking,
  clearTracking,
  applyBackfill,
  ensureCurrentYear,
} from "./state.js";
import { formatTopic, lastSeenPhrase } from "./counter.js";
import { TopicUpdater } from "./topic-updater.js";
import { CatchUp } from "./catch-up.js";
import {
  commandData,
  backfillChannel,
  PRIVILEGED_SUBCOMMANDS,
  REQUIRED_PERMISSION,
} from "./commands.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and set it.");
  process.exit(1);
}

const refreshMinutes = Number(process.env.TOPIC_REFRESH_MINUTES) || 60;

// Minimum spacing between topic edits, in seconds. Default 300s (5 min) — the
// Discord rate-limit floor. Lower values risk 429s and can make updates lag
// more, not less. Env override lets you experiment.
const topicMinIntervalSec = Number(process.env.TOPIC_MIN_INTERVAL_SECONDS) || 300;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable it in the dev portal
  ],
});

const topics = new TopicUpdater(topicMinIntervalSec * 1000);

// Counts live messages, and on startup walks each tracked channel from where
// its count left off so nothing posted while the bot was down is missed.
const catchUp = new CatchUp({
  onSighting: (message) =>
    trackedChannelFor(message.channel).then((channel) => {
      if (channel) refreshTopic(channel);
    }),
});

/** Queue a topic update for a channel using its freshest stored stats. */
function refreshTopic(channel) {
  topics.request(channel, () => formatTopic(getChannel(channel.id)));
}

/**
 * Threads roll up into the channel that owns them: that's where the tracked
 * entry lives and the only place a topic can be written. For a thread, returns
 * the parent channel (fetching it if it isn't cached); for anything else, the
 * channel itself. Null if a thread's parent can't be resolved.
 */
async function trackedChannelFor(channel) {
  if (!channel?.isThread()) return channel;
  return channel.parent ?? client.channels.fetch(channel.parentId).catch(() => null);
}

/** Id-only version of the above for the hot path: no fetch, no await. */
function trackedChannelIdFor(message) {
  return message.channel?.isThread() ? message.channel.parentId : message.channelId;
}

// ---- Message tracking -------------------------------------------------------

client.on(Events.MessageCreate, (message) => {
  if (message.author?.bot) return;
  const channelId = trackedChannelIdFor(message);
  if (!getChannel(channelId)) return;
  catchUp.handleLive(channelId, message);
});

// ---- Slash commands ---------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "counter") return;

  const sub = interaction.options.getSubcommand();

  if (
    PRIVILEGED_SUBCOMMANDS.has(sub) &&
    !interaction.memberPermissions?.has(REQUIRED_PERMISSION)
  ) {
    return interaction.reply({
      content: "You need the **Manage Channels** permission to do that.",
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    // Commands run inside a thread apply to the thread's parent channel.
    const channel =
      (await trackedChannelFor(interaction.channel)) ?? interaction.channel;
    const channelId = channel?.id ?? interaction.channelId;
    const where =
      channelId === interaction.channelId
        ? "this channel"
        : `<#${channelId}> (this thread's parent channel)`;

    if (sub === "set") {
      const trackString = interaction.options.getString("string", true);
      setTracking(channelId, trackString);
      refreshTopic(channel);
      return interaction.reply({
        content:
          `Now counting ${trackString} in ${where}. ` +
          "The stats will appear in the channel topic shortly.\n" +
          "Run `/counter backfill` to seed the year-to-date count from history.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === "show") {
      const entry = getChannel(channelId);
      if (!entry) {
        return interaction.reply({
          content:
            "Nothing is tracked in this channel yet. Use `/counter set`.",
          flags: MessageFlags.Ephemeral,
        });
      }
      ensureCurrentYear(entry);
      return interaction.reply({
        content:
          `${entry.trackString} — **${entry.count}** in ${entry.year} · ` +
          lastSeenPhrase(entry.lastSeen),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === "backfill") {
      const entry = getChannel(channelId);
      if (!entry) {
        return interaction.reply({
          content: "Nothing is tracked here yet. Use `/counter set` first.",
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await backfillChannel(channel, entry.trackString);
      applyBackfill(channelId, result);
      refreshTopic(channel);
      const t = result.threads;
      const threadNote = t ? ` (incl. ${t} thread${t === 1 ? "" : "s"})` : "";
      const s = result.skippedThreads;
      const skippedNote = s
        ? `\n⚠️ Skipped ${s} thread${s === 1 ? "" : "s"} the bot can't read.`
        : "";
      return interaction.editReply(
        `Backfill complete: **${result.count}** occurrences of ` +
          `${entry.trackString} in ${result.year}${threadNote} · ` +
          lastSeenPhrase(result.lastSeen) +
          skippedNote,
      );
    }

    if (sub === "clear") {
      const had = clearTracking(channelId);
      return interaction.reply({
        content: had
          ? "Stopped tracking this channel. (The topic is left as-is.)"
          : "This channel wasn't being tracked.",
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error("Command handler error:", err);
    const msg = "Something went wrong handling that command.";
    if (interaction.deferred || interaction.replied) {
      interaction.editReply(msg).catch(() => {});
    } else {
      interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(
        () => {},
      );
    }
  }
});

// ---- Startup ----------------------------------------------------------------

async function registerGuildCommands(guild) {
  try {
    await guild.commands.set(commandData);
  } catch (err) {
    console.error(`Failed to register commands in ${guild.name}:`, err.message);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  // Register commands per guild for instant availability.
  await Promise.all(c.guilds.cache.map(registerGuildCommands));

  // Count whatever was posted while we were down, before the first topic push.
  await catchUp.run((id) => c.channels.fetch(id));

  // Push an initial topic for every tracked channel and start a periodic
  // refresh so "days since last seen" stays current without new sightings.
  const refreshAll = async () => {
    saveState(); // also persists cursor-only progress (see recordSightings)
    for (const [channelId] of getTrackedChannels()) {
      try {
        const channel = await c.channels.fetch(channelId);
        if (channel) refreshTopic(channel);
      } catch (err) {
        console.error(`Could not refresh channel ${channelId}:`, err.message);
      }
    }
  };

  await refreshAll();
  const interval = setInterval(refreshAll, refreshMinutes * 60 * 1000);
  if (typeof interval.unref === "function") interval.unref();
});

client.on(Events.GuildCreate, registerGuildCommands);

// ---- Lifecycle --------------------------------------------------------------

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; // ignore a second Ctrl+C / duplicate signal
  shuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down...`);
  try {
    await flushState();
  } catch (err) {
    console.error("Error flushing state on shutdown:", err.message);
  }
  await client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await loadState();
catchUp.prepare(); // before login, so nothing live can move a cursor first
await client.login(token);
