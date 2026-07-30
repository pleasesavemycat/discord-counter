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
  getChannel,
  getTrackedChannels,
  setTracking,
  clearTracking,
  recordSightings,
  applyBackfill,
  ensureCurrentYear,
} from "./state.js";
import { countOccurrences, formatTopic, lastSeenPhrase } from "./counter.js";
import { TopicUpdater } from "./topic-updater.js";
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

/** Queue a topic update for a channel using its freshest stored stats. */
function refreshTopic(channel) {
  topics.request(channel, () => formatTopic(getChannel(channel.id)));
}

// ---- Message tracking -------------------------------------------------------

client.on(Events.MessageCreate, (message) => {
  if (message.author?.bot) return;
  const entry = getChannel(message.channelId);
  if (!entry) return;

  const hits = countOccurrences(message.content, entry.trackString);
  if (hits === 0) return;

  recordSightings(message.channelId, hits, message.createdTimestamp);
  refreshTopic(message.channel);
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
    if (sub === "set") {
      const trackString = interaction.options.getString("string", true);
      setTracking(interaction.channelId, trackString);
      refreshTopic(interaction.channel);
      return interaction.reply({
        content:
          `Now counting ${trackString} in this channel. ` +
          "The stats will appear in the channel topic shortly.\n" +
          "Run `/counter backfill` to seed the year-to-date count from history.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === "show") {
      const entry = getChannel(interaction.channelId);
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
      const entry = getChannel(interaction.channelId);
      if (!entry) {
        return interaction.reply({
          content: "Nothing is tracked here yet. Use `/counter set` first.",
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await backfillChannel(
        interaction.channel,
        entry.trackString,
      );
      applyBackfill(interaction.channelId, result);
      refreshTopic(interaction.channel);
      return interaction.editReply(
        `Backfill complete: **${result.count}** occurrences of ` +
          `${entry.trackString} in ${result.year} · ` +
          lastSeenPhrase(result.lastSeen),
      );
    }

    if (sub === "clear") {
      const had = clearTracking(interaction.channelId);
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

  // Push an initial topic for every tracked channel and start a periodic
  // refresh so "days since last seen" stays current without new sightings.
  const refreshAll = async () => {
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
await client.login(token);
