// Pure helpers for counting occurrences and formatting the display string.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Strip Unicode variation selectors (U+FE0E text / U+FE0F emoji presentation).
 * These are invisible and only affect how an emoji is *rendered*, not which
 * emoji it is — so "❤️" (U+2764 U+FE0F) and "❤" (U+2764) should match.
 */
export function stripVariationSelectors(s) {
  return s.replace(/[\uFE0E\uFE0F]/g, "");
}

// A grapheme cluster that renders as a pictograph: emoji, flags, keycaps.
const EMOJI_CLUSTER = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;
// What may sit between two emoji without breaking the sequence: whitespace and
// the invisible spaces/joiners some keyboards insert.
const EMOJI_GAP = "[\\s\\u200B-\\u200D]*";
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Split a tracked string into the units the matcher works with: Discord custom
 * emoji markup (<:name:id>), and otherwise grapheme clusters. Each token says
 * whether it's emoji-like or whitespace. Whitespace runs collapse to one token,
 * and whitespace between two emoji is dropped entirely: Discord's desktop
 * emoji picker and :autocomplete: insert a space after every emoji, so
 * "🐿️ 💀" is how most people end up typing "🐿️💀".
 */
export function needleTokens(needle) {
  const raw = [];
  const addText = (text) => {
    for (const { segment } of segmenter.segment(text)) {
      const space = /^\s+$/.test(segment);
      if (space && raw.at(-1)?.space) continue;
      raw.push({ text: segment, space, emoji: !space && EMOJI_CLUSTER.test(segment) });
    }
  };
  let last = 0;
  for (const m of needle.trim().matchAll(/<a?:\w+:\d+>/g)) {
    addText(needle.trim().slice(last, m.index));
    raw.push({ text: m[0], space: false, emoji: true });
    last = m.index + m[0].length;
  }
  addText(needle.trim().slice(last));
  return raw.filter((t, i) => !(t.space && raw[i - 1]?.emoji && raw[i + 1]?.emoji));
}

const matchers = new Map(); // needle -> RegExp (or null when it has nothing to match)

/**
 * Compile `needle` into a regex: literal tokens in order, whitespace tokens as
 * any whitespace run, and any amount of whitespace/invisible joiners allowed
 * between two adjacent emoji. Text stays exact (and case-sensitive).
 */
function matcherFor(needle) {
  if (matchers.has(needle)) return matchers.get(needle);
  const tokens = needleTokens(needle);
  let src = "";
  tokens.forEach((t, i) => {
    if (t.space) {
      src += "\\s+";
      return;
    }
    if (t.emoji && tokens[i - 1]?.emoji) src += EMOJI_GAP;
    src += escapeRe(stripVariationSelectors(t.text));
  });
  const re = src ? new RegExp(src, "gu") : null;
  matchers.set(needle, re);
  return re;
}

/**
 * Count non-overlapping occurrences of `needle` inside `haystack`.
 * Works for unicode emoji (🎉) and Discord custom emoji markup (<:name:id>)
 * alike, since both appear literally in a message's raw content.
 *
 * Variation selectors are normalized away on both sides, and whitespace or
 * invisible joiners between the emoji of a multi-emoji needle are ignored
 * (see needleTokens). Order still matters: "💀🐿️" is not "🐿️💀".
 *
 * "Occurrences" means instances, so "🎉🎉🎉" counts as 3 for needle "🎉".
 */
export function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  const re = matcherFor(needle);
  if (!re) return 0;
  let count = 0;
  for (const _ of stripVariationSelectors(haystack).matchAll(re)) count += 1;
  return count;
}

/** Whole-day difference between two timestamps (ms). */
export function daysBetween(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / MS_PER_DAY);
}

/** Human phrase for how long ago a sighting was. */
export function lastSeenPhrase(lastSeenMs, now = Date.now()) {
  if (!lastSeenMs) return "never seen yet";
  const days = daysBetween(lastSeenMs, now);
  if (days <= 0) return "last seen today";
  if (days === 1) return "last seen yesterday";
  return `last seen ${days} days ago`;
}

/**
 * Build the channel-topic string, e.g.
 *   "🎉 · 42 in 2026 · last seen 3 days ago"
 * Discord topics are capped at 1024 chars; this is always well under.
 */
export function formatTopic(entry, now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const count = entry.year === year ? entry.count : 0;
  return `${entry.trackString} · ${count} in ${year} · ${lastSeenPhrase(
    entry.lastSeen,
    now,
  )}`;
}
