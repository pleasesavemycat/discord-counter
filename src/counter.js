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

/**
 * Count non-overlapping occurrences of `needle` inside `haystack`.
 * Works for unicode emoji (🎉) and Discord custom emoji markup (<:name:id>)
 * alike, since both appear literally in a message's raw content.
 *
 * Variation selectors are normalized away on both sides so emoji that look
 * identical but differ only by a hidden presentation codepoint still match.
 *
 * "Occurrences" means instances, so "🎉🎉🎉" counts as 3 for needle "🎉".
 */
export function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  const hay = stripVariationSelectors(haystack);
  const need = stripVariationSelectors(needle);
  if (!need) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = hay.indexOf(need, index);
    if (found === -1) break;
    count += 1;
    index = found + need.length; // non-overlapping
  }
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
