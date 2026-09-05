// Startup catch-up: count what was posted while the bot was down.
//
// The live listener only sees messages that arrive while the bot is connected.
// So each tracked entry keeps a cursor, `countedThrough`: every message created
// at or before it has been accounted for. On startup each tracked channel is
// re-walked (threads included) from that cursor to the present, and the cursor
// moves up.
//
// The live path and the scan can overlap: a message posted moments before the
// scan's first page can also arrive through the gateway. So until a channel's
// scan has finished, its live messages are held back and replayed afterwards,
// skipping ids the scan already counted. That also keeps the saved state
// honest if the process dies mid-scan: nothing about a channel changes until
// its scan has fully succeeded, so the next start resumes from the same cursor.

import { countOccurrences } from "./counter.js";
import { messagesSince } from "./history.js";
import {
  applyCatchUp,
  catchUpFloor,
  getChannel,
  getTrackedChannels,
  recordSightings,
} from "./state.js";

// How long after the last scan the live path keeps checking ids against what
// the scans counted. Covers a gateway delivery that trails the REST fetch that
// already saw the same message.
const OVERLAP_GRACE_MS = 60 * 1000;

export class CatchUp {
  /** `onSighting(message)` runs after a live message with hits is counted. */
  constructor({ onSighting }) {
    this.onSighting = onSighting;
    this.floors = new Map(); // channelId -> first ms not yet accounted for
    this.held = new Map(); // channelId -> live messages waiting on that channel's scan
    this.scanned = new Set(); // message ids counted by a scan
  }

  /**
   * Snapshot where each tracked channel left off. Call after loadState() and
   * before login, so no live message can move a cursor before it's read.
   */
  prepare(now = Date.now()) {
    for (const [channelId, entry] of getTrackedChannels()) {
      this.floors.set(channelId, catchUpFloor(entry, now));
      this.held.set(channelId, []);
    }
  }

  /** Live path. `channelId` is the tracked (parent) channel the message counts for. */
  handleLive(channelId, message) {
    const held = this.held.get(channelId);
    if (held) {
      held.push(message);
      return;
    }
    this.count(channelId, message);
  }

  count(channelId, message) {
    if (this.scanned.has(message.id)) return;
    const entry = getChannel(channelId);
    if (!entry) return; // untracked while it was held
    const hits = countOccurrences(message.content, entry.trackString);
    recordSightings(channelId, hits, message.createdTimestamp);
    if (hits > 0) this.onSighting(message);
  }

  /**
   * Walk every prepared channel from its cursor to now, one at a time, then
   * release that channel's held messages. `fetchChannel(id)` resolves a
   * channel. A failure skips that channel: its cursor stays put (so the next
   * start tries again) unless live messages arrived meanwhile, in which case
   * the gap can only be repaired by a backfill, and the log says so.
   */
  async run(fetchChannel) {
    for (const [channelId, floorMs] of this.floors) {
      try {
        const channel = await fetchChannel(channelId);
        const entry = getChannel(channelId);
        if (channel && entry) {
          const result = await this.scan(channel, entry.trackString, floorMs);
          applyCatchUp(channelId, result);
          console.log(
            `Catch-up #${channel.name}: ${result.scanned} message(s) since ` +
              `${new Date(floorMs).toISOString()}, +${result.hits} ${entry.trackString}`,
          );
        }
      } catch (err) {
        console.error(
          `Catch-up failed for channel ${channelId} (${err.message}); ` +
            "run /counter backfill there to repair the count.",
        );
      } finally {
        const held = this.held.get(channelId) ?? [];
        this.held.delete(channelId);
        for (const message of held) this.count(channelId, message);
      }
    }
    this.floors.clear();
    const timer = setTimeout(() => this.scanned.clear(), OVERLAP_GRACE_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  /**
   * Tally `trackString` in `channel` (threads included) from `floorMs` to the
   * present, never reaching back before the current year. `scannedAt` is taken
   * before the first fetch, so it is a safe new cursor.
   */
  async scan(channel, trackString, floorMs, now = Date.now()) {
    const year = new Date(now).getUTCFullYear();
    const sinceMs = Math.max(floorMs, Date.UTC(year, 0, 1));
    let hits = 0;
    let lastSeen = null;
    let scanned = 0;
    for await (const msg of messagesSince(channel, sinceMs)) {
      scanned += 1;
      this.scanned.add(msg.id);
      const n = countOccurrences(msg.content, trackString);
      if (n === 0) continue;
      hits += n;
      if (!lastSeen || msg.createdTimestamp > lastSeen) lastSeen = msg.createdTimestamp;
    }
    return { hits, lastSeen, scannedAt: now, scanned };
  }
}
