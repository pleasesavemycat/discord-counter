// Tiny JSON-file persistence for per-channel counter state.
//
// Shape:
// {
//   channels: {
//     "<channelId>": {
//       trackString: "🎉",   // the emoji/text being counted
//       count: 42,            // occurrences so far in `year`
//       year: 2026,           // year the count belongs to (for YTD reset)
//       lastSeen: 1690000000000 | null  // ms timestamp of last sighting
//       countedThrough: 1690000000000 | null  // every message created at or
//           // before this ms is accounted for; startup catch-up resumes here
//     }
//   }
// }

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets the container point this at a mounted volume; unset, it stays
// the repo's own data/ folder so a local `npm start` behaves as it always has.
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : join(__dirname, "..", "data");
const STATE_FILE = join(DATA_DIR, "state.json");

let state = { channels: {} };
let saveTimer = null;

export async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.channels) {
      state = parsed;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Failed to read state file, starting fresh:", err.message);
    }
  }
  return state;
}

async function doWrite() {
  await mkdir(DATA_DIR, { recursive: true });
  // Include the pid in the temp name so separate processes can't collide.
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, STATE_FILE); // atomic replace
}

// Serialize all writes through a single chain so a debounced save and a
// shutdown flush (or a double shutdown signal) can never run concurrently and
// race on the temp file — the cause of the ENOENT-on-rename error.
let writeQueue = Promise.resolve();

function writeNow() {
  const run = writeQueue.catch(() => {}).then(doWrite);
  writeQueue = run.catch(() => {}); // swallow errors so the chain stays alive
  return run; // caller still sees this write's own success/failure
}

/** Debounced save so bursts of sightings don't thrash the disk. */
export function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await writeNow();
    } catch (err) {
      console.error("Failed to save state:", err.message);
    }
  }, 1000);
}

/** Flush any pending save immediately (used on shutdown). */
export async function flushState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await writeNow();
}

export function getChannel(channelId) {
  return state.channels[channelId];
}

export function getTrackedChannels() {
  return Object.entries(state.channels);
}

export function setTracking(channelId, trackString) {
  const existing = state.channels[channelId];
  state.channels[channelId] = {
    // Discord's emoji picker leaves a trailing space; that must not become
    // part of what we look for.
    trackString: trackString.trim(),
    count: existing?.count ?? 0,
    year: existing?.year ?? new Date().getUTCFullYear(),
    lastSeen: existing?.lastSeen ?? null,
    // History before this moment is only ever counted by an explicit backfill.
    countedThrough: existing?.countedThrough ?? Date.now(),
  };
  saveState();
  return state.channels[channelId];
}

export function clearTracking(channelId) {
  const had = Boolean(state.channels[channelId]);
  delete state.channels[channelId];
  saveState();
  return had;
}

/** Roll the count over to the current year if we've crossed into a new one. */
export function ensureCurrentYear(entry, now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  if (entry.year !== year) {
    entry.year = year;
    entry.count = 0;
    // lastSeen is intentionally preserved so "days since" spans year boundaries.
  }
  return entry;
}

function advanceCursor(entry, throughMs) {
  if (!entry.countedThrough || throughMs > entry.countedThrough) {
    entry.countedThrough = throughMs;
  }
}

/**
 * Record a live message: `occurrences` new sightings at time `at` (0 is fine).
 * Either way the channel's history is now accounted for through `at`; that
 * cursor is where a startup catch-up resumes. A cursor-only change isn't saved
 * on its own — it rides along with the next save (a hit, the hourly refresh,
 * shutdown) — so after a crash the worst case is re-walking a few messages
 * that had no hits.
 */
export function recordSightings(channelId, occurrences, at = Date.now()) {
  const entry = state.channels[channelId];
  if (!entry) return null;
  advanceCursor(entry, at);
  if (occurrences === 0) return entry;
  ensureCurrentYear(entry, at);
  entry.count += occurrences;
  if (!entry.lastSeen || at > entry.lastSeen) entry.lastSeen = at;
  saveState();
  return entry;
}

/** Overwrite a channel's tallies (used after a history backfill). */
export function applyBackfill(channelId, { count, year, lastSeen, scannedAt }) {
  const entry = state.channels[channelId];
  if (!entry) return null;
  entry.count = count;
  entry.year = year;
  entry.lastSeen = lastSeen;
  if (scannedAt) advanceCursor(entry, scannedAt);
  saveState();
  return entry;
}

/** Fold in what a startup catch-up scan found and move the cursor to when it began. */
export function applyCatchUp(channelId, { hits, lastSeen, scannedAt }) {
  const entry = state.channels[channelId];
  if (!entry) return null;
  ensureCurrentYear(entry, scannedAt);
  entry.count += hits;
  if (lastSeen && (!entry.lastSeen || lastSeen > entry.lastSeen)) {
    entry.lastSeen = lastSeen;
  }
  advanceCursor(entry, scannedAt);
  saveState();
  return entry;
}

/**
 * First ms a startup catch-up should look at for `entry`. Entries saved before
 * the cursor existed fall back to the last sighting (every hit after it is by
 * definition uncounted), and to "now" if there has never been one — then, as
 * before, only an explicit backfill looks at history.
 */
export function catchUpFloor(entry, now = Date.now()) {
  return (entry.countedThrough ?? entry.lastSeen ?? now) + 1;
}
