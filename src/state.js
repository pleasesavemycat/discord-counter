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
//     }
//   }
// }

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
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
    trackString,
    count: existing?.count ?? 0,
    year: existing?.year ?? new Date().getUTCFullYear(),
    lastSeen: existing?.lastSeen ?? null,
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

/** Record `occurrences` new sightings at time `at`. */
export function recordSightings(channelId, occurrences, at = Date.now()) {
  const entry = state.channels[channelId];
  if (!entry) return null;
  ensureCurrentYear(entry, at);
  entry.count += occurrences;
  if (!entry.lastSeen || at > entry.lastSeen) entry.lastSeen = at;
  saveState();
  return entry;
}

/** Overwrite a channel's tallies (used after a history backfill). */
export function applyBackfill(channelId, { count, year, lastSeen }) {
  const entry = state.channels[channelId];
  if (!entry) return null;
  entry.count = count;
  entry.year = year;
  entry.lastSeen = lastSeen;
  saveState();
  return entry;
}
