// Rate-limit-aware channel topic writer.
//
// Discord limits channel edits (name/topic) to roughly 2 per 10 minutes per
// channel. We enforce a conservative minimum interval between edits and
// coalesce rapid requests: only the most recent desired topic is ever written.

const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 1000; // 6 min -> < 2 per 10 min

export class TopicUpdater {
  constructor(minIntervalMs = DEFAULT_MIN_INTERVAL_MS) {
    this.minIntervalMs = minIntervalMs;
    // channelId -> { channel, computeFn, lastEditAt, timer }
    this.entries = new Map();
  }

  /**
   * Request that `channel`'s topic be updated. `computeFn` is called lazily at
   * write time so the freshest stats (including "days since") are used.
   */
  request(channel, computeFn) {
    let entry = this.entries.get(channel.id);
    if (!entry) {
      entry = { channel, computeFn, lastEditAt: 0, timer: null };
      this.entries.set(channel.id, entry);
    } else {
      entry.channel = channel;
      entry.computeFn = computeFn;
    }
    this._schedule(entry);
  }

  _schedule(entry) {
    if (entry.timer) return; // a flush is already queued
    const wait = Math.max(0, entry.lastEditAt + this.minIntervalMs - Date.now());
    entry.timer = setTimeout(() => this._flush(entry), wait);
    if (typeof entry.timer.unref === "function") entry.timer.unref();
  }

  async _flush(entry) {
    entry.timer = null;
    const compute = entry.computeFn;
    entry.computeFn = null;
    if (!compute) return;

    const topic = compute();
    try {
      await entry.channel.setTopic(topic);
    } catch (err) {
      console.error(
        `Failed to set topic for #${entry.channel?.name ?? entry.channel?.id}:`,
        err.message,
      );
    } finally {
      // Count the attempt against the cooldown either way, so an error can't
      // turn into a tight retry loop.
      entry.lastEditAt = Date.now();
    }

    // If a newer request arrived while we were awaiting, schedule it.
    if (entry.computeFn) this._schedule(entry);
  }
}
