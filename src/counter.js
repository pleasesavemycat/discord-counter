// Pure helpers for counting occurrences and formatting the display string.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Count non-overlapping occurrences of `needle` inside `haystack`.
 * Works for unicode emoji (🎉) and Discord custom emoji markup (<:name:id>)
 * alike, since both appear literally in a message's raw content.
 *
 * "Occurrences" means instances, so "🎉🎉🎉" counts as 3 for needle "🎉".
 */
export function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length; // non-overlapping
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
