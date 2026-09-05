// One-off diagnostic: figure out why occurrences of a string aren't being
// counted the way you expect. Read-only — it never edits anything.
//
// Usage:
//   node src/diagnose.js <channelId> ["<string>"]
//
//   - With no string, it counts the string the bot has STORED for that channel
//     (from data/state.json) — i.e. exactly what /counter backfill uses.
//   - With a string, it ALSO counts that, so you can compare the stored string
//     against what you expect and spot an encoding mismatch.
//
// Example:
//   node src/diagnose.js 123456789012345678 "❤️"

import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import {
  countOccurrences,
  needleTokens,
  stripVariationSelectors,
} from "./counter.js";
import { loadState, getChannel } from "./state.js";
import { messagesSince } from "./history.js";

const token = process.env.DISCORD_TOKEN;
const channelId = process.argv[2];
const trackArg = process.argv[3];

if (!token) { console.error("Missing DISCORD_TOKEN"); process.exit(1); }
if (!channelId) {
  console.error('Usage: node src/diagnose.js <channelId> ["<string>"]');
  process.exit(1);
}

await loadState();
const stored = getChannel(channelId);

// Build the list of strings to count and compare.
const candidates = [];
if (stored?.trackString) {
  candidates.push({ label: "STORED (what backfill uses)", s: stored.trackString });
}
if (trackArg && trackArg !== stored?.trackString) {
  candidates.push({ label: "ARGUMENT (what you typed)", s: trackArg });
}
if (candidates.length === 0) {
  console.error(
    "Nothing to count: no string stored for that channel and none passed.\n" +
      'Pass one explicitly: node src/diagnose.js <channelId> "<string>"',
  );
  process.exit(1);
}

const codepoints = (s) =>
  [...s]
    .map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"))
    .join(" ");

// True when `content` contains every emoji of `needle` somewhere, in any order
// — a message that "looks like" it should count.
function hasEveryEmoji(content, needle) {
  const emoji = needleTokens(needle).filter((t) => t.emoji);
  if (emoji.length === 0) return false;
  const hay = stripVariationSelectors(content);
  return emoji.every((t) => hay.includes(stripVariationSelectors(t.text)));
}
const clip = (s, n = 120) => (s.length > n ? s.slice(0, n) + "…" : s);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", async (c) => {
  const channel = await c.channels.fetch(channelId);
  if (channel.isThread()) {
    console.error(
      `${channelId} is a thread. Threads count toward their parent channel; ` +
        `pass the parent's id instead: ${channel.parentId}`,
    );
    await c.destroy();
    process.exit(1);
  }
  const year = new Date().getUTCFullYear();
  const yearStartMs = Date.UTC(year, 0, 1);

  const counts = candidates.map(() => 0);
  let scanned = 0;

  // Same walk as /counter backfill: the channel plus its threads.
  const stats = {};
  const botCounts = candidates.map(() => 0); // hits inside bot/webhook posts
  const nearMisses = candidates.map(() => []); // every emoji present, no match
  for await (const msg of messagesSince(channel, yearStartMs, stats)) {
    scanned++;
    const fromBot = Boolean(msg.author?.bot || msg.webhookId);
    candidates.forEach((cand, i) => {
      const n = countOccurrences(msg.content, cand.s);
      counts[i] += n;
      if (fromBot) botCounts[i] += n;
      if (n === 0 && nearMisses[i].length < 10 && hasEveryEmoji(msg.content, cand.s)) {
        nearMisses[i].push(msg);
      }
    });
  }

  console.log(`\nChannel: #${channel.name} (${channel.id})`);
  console.log(
    `Scanned ${scanned} messages in ${year} ` +
      `(channel + ${stats.threads} threads; ${stats.skippedThreads} unreadable)\n`,
  );

  candidates.forEach((cand, i) => {
    console.log(`${cand.label}`);
    console.log(`  string:     "${cand.s}"`);
    console.log(`  codepoints: ${codepoints(cand.s)}`);
    console.log(`  count:      ${counts[i]}`);
    if (botCounts[i]) {
      console.log(`    of which ${botCounts[i]} in bot/webhook posts: backfill and startup`);
      console.log(`    catch-up count those, the live listener skips them.`);
    }
    if (nearMisses[i].length) {
      console.log(`  near misses: contain every emoji of the string but don't match`);
      console.log(`  (first ${nearMisses[i].length}; compare codepoints and spacing/order):`);
      for (const m of nearMisses[i]) {
        const c = clip(m.content);
        console.log(`    • ${JSON.stringify(c)}  [${codepoints(c)}]`);
        console.log(`      ${m.url}`);
      }
    }
    console.log("");
  });

  if (stored) {
    const through = stored.countedThrough
      ? new Date(stored.countedThrough).toISOString()
      : "none";
    console.log(
      `state.json says: count=${stored.count} year=${stored.year} countedThrough=${through}`,
    );
    if (stored.year === year && stored.count !== counts[0]) {
      console.log(`=> Stored count differs from a fresh scan by ${counts[0] - stored.count}.`);
      console.log("   /counter backfill would set it to the scan result.");
    }
    console.log("");
  }

  if (candidates.length === 2) {
    if (counts[0] === counts[1]) {
      console.log("=> Both strings count the same. The stored string is fine;");
      console.log("   the mismatch is elsewhere (check you're on the same channel).");
    } else {
      console.log("=> The STORED string and the one you typed count DIFFERENTLY.");
      console.log("   The bot uses the STORED one. Compare the codepoints above:");
      console.log("   if they differ, re-run  /counter set  with the correct emoji");
      console.log("   (or fix trackString in data/state.json).");
    }
  }

  await c.destroy();
  process.exit(0);
});

client.login(token);
