// One-off diagnostic: figure out why some occurrences of a string aren't being
// counted in a channel. Read-only — it never edits anything.
//
// Usage:
//   node src/diagnose.js <channelId> "<string>"
//
// Example:
//   node src/diagnose.js 123456789012345678 "❤️"
//
// It reports, for the current year's messages in that channel:
//   - the exact codepoints of your tracked string
//   - a STRICT count (exact substring match, the old behavior)
//   - a LENIENT count (ignores variation selectors, the new behavior)
//   - sample messages that only match leniently (the culprits)
//   - any custom emoji whose name is reused under different IDs

import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { countOccurrences, stripVariationSelectors } from "./counter.js";

const token = process.env.DISCORD_TOKEN;
const channelId = process.argv[2];
const trackString = process.argv[3];

if (!token) { console.error("Missing DISCORD_TOKEN"); process.exit(1); }
if (!channelId || !trackString) {
  console.error('Usage: node src/diagnose.js <channelId> "<string>"');
  process.exit(1);
}

const codepoints = (s) =>
  [...s]
    .map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"))
    .join(" ");

// STRICT = exact substring, no normalization (the original behavior).
function strictCount(haystack, needle) {
  if (!haystack || !needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("clientReady", async (c) => {
  const channel = await c.channels.fetch(channelId);
  const year = new Date().getUTCFullYear();
  const yearStartMs = Date.UTC(year, 0, 1);

  let strict = 0, lenient = 0, scanned = 0;
  const nearMisses = [];
  const customEmojiIds = new Map(); // name -> Set(ids)
  const customRe = /<(a?):(\w+):(\d+)>/g;

  let before;
  outer: while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    for (const msg of batch.values()) {
      if (msg.createdTimestamp < yearStartMs) break outer;
      scanned++;
      const s = strictCount(msg.content, trackString);
      const l = countOccurrences(msg.content, trackString);
      strict += s;
      lenient += l;
      if (l > s && nearMisses.length < 10) {
        nearMisses.push(msg.content);
      }
      for (const m of msg.content.matchAll(customRe)) {
        const [, , name, id] = m;
        if (!customEmojiIds.has(name)) customEmojiIds.set(name, new Set());
        customEmojiIds.get(name).add(id);
      }
      before = msg.id;
    }
    if (batch.size < 100) break;
  }

  console.log(`\nChannel: #${channel.name}  (scanned ${scanned} messages in ${year})`);
  console.log(`Tracked string: "${trackString}"`);
  console.log(`  codepoints: ${codepoints(trackString)}`);
  console.log(`  after stripping variation selectors: ${codepoints(stripVariationSelectors(trackString))}`);
  console.log(`\nSTRICT  (exact match) count:   ${strict}`);
  console.log(`LENIENT (new match)  count:   ${lenient}`);

  if (lenient > strict) {
    console.log(`\n=> ${lenient - strict} occurrence(s) differed only by variation selectors.`);
    console.log(`   The fix in counter.js now catches these. Re-run /counter backfill.`);
    console.log(`\n   Example messages that only matched leniently:`);
    for (const c of nearMisses) console.log(`   • ${JSON.stringify(c)}  [${codepoints(c)}]`);
  } else {
    console.log(`\n=> Variation selectors are NOT the cause (strict == lenient).`);
  }

  const dupes = [...customEmojiIds.entries()].filter(([, ids]) => ids.size > 1);
  if (dupes.length) {
    console.log(`\nCustom emoji names used under MULTIPLE IDs (a likely cause if your`);
    console.log(`tracked string is a custom emoji — only one ID will ever match):`);
    for (const [name, ids] of dupes) {
      console.log(`   :${name}: -> ${[...ids].join(", ")}`);
    }
  }

  await c.destroy();
  process.exit(0);
});

client.login(token);
