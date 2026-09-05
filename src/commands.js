// Slash command definitions and history backfill logic.

import {
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { countOccurrences } from "./counter.js";
import { messagesSince } from "./history.js";

export const counterCommand = new SlashCommandBuilder()
  .setName("counter")
  .setDescription("Track how often an emoji string appears in this channel")
  .addSubcommand((s) =>
    s
      .setName("set")
      .setDescription("Set the emoji/text to count in this channel")
      .addStringOption((o) =>
        o
          .setName("string")
          .setDescription("The emoji or text to count (e.g. 🎉)")
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s.setName("show").setDescription("Show the current stats for this channel"),
  )
  .addSubcommand((s) =>
    s
      .setName("backfill")
      .setDescription("Scan this channel's history to recount for the year"),
  )
  .addSubcommand((s) =>
    s.setName("clear").setDescription("Stop tracking this channel"),
  )
  // Anyone can run /counter show; set/backfill/clear are gated in code by
  // requiring Manage Channels. We leave the command visible to everyone.
  .setDMPermission(false);

export const commandData = [counterCommand.toJSON()];

// Subcommands that change configuration require Manage Channels.
export const PRIVILEGED_SUBCOMMANDS = new Set(["set", "backfill", "clear"]);
export const REQUIRED_PERMISSION = PermissionFlagsBits.ManageChannels;

/**
 * Walk a channel's history — its top-level messages plus every thread that
 * could hold a message this year — and tally occurrences of `trackString` for
 * the current calendar year (UTC).
 * Returns { count, year, lastSeen, threads, skippedThreads }.
 *
 * discord.js transparently handles pagination rate limits; for very active
 * channels this can take a while, which is why callers should defer the reply.
 */
export async function backfillChannel(channel, trackString, now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const yearStartMs = Date.UTC(year, 0, 1);

  let count = 0;
  let lastSeen = null;
  const stats = {};

  for await (const msg of messagesSince(channel, yearStartMs, stats)) {
    const hits = countOccurrences(msg.content, trackString);
    if (hits === 0) continue;
    count += hits;
    if (!lastSeen || msg.createdTimestamp > lastSeen) {
      lastSeen = msg.createdTimestamp;
    }
  }

  return { count, year, lastSeen, ...stats };
}
