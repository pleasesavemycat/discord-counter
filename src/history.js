// Walk a channel's message history — including its threads — for a time window.
//
// Threads roll up into the channel that owns them: a sighting inside a thread
// counts for the parent channel, which is also the only place a topic can be
// written. So "the channel's history" means its top-level messages plus every
// thread that could hold a message in the window.

import { PermissionFlagsBits } from "discord.js";

/**
 * Yield the messages of one history (a channel or a thread) posted at or after
 * `sinceMs`, newest first. Discord pages newest -> oldest, so the walk stops at
 * the first message older than the window.
 */
async function* historySince(target, sinceMs) {
  let before;
  while (true) {
    const batch = await target.messages.fetch({ limit: 100, before });
    if (batch.size === 0) return;
    for (const msg of batch.values()) {
      if (msg.createdTimestamp < sinceMs) return;
      yield msg;
      before = msg.id; // oldest seen so far -> next page continues before it
    }
    if (batch.size < 100) return;
  }
}

/**
 * Yield the archived threads of `channel` that were archived at or after
 * `sinceMs`. A thread can't receive messages while archived, so anything
 * archived before the window holds nothing we want.
 *
 * The public listing (and, with Manage Threads, the full private one) is
 * sorted by archive time and pages by timestamp, so it can stop early. The
 * joined-private listing is sorted by id and pages by id, so it has to be read
 * to the end and filtered.
 */
async function* archivedThreadsSince(channel, { type, fetchAll = false }, sinceMs) {
  const byArchiveTime = type === "public" || fetchAll;
  let before;
  while (true) {
    const page = await channel.threads.fetchArchived({ type, fetchAll, before, limit: 100 });
    if (page.threads.size === 0) return;
    for (const thread of page.threads.values()) {
      if (thread.archiveTimestamp < sinceMs) {
        if (byArchiveTime) return;
        continue;
      }
      yield thread;
    }
    if (!page.hasMore) return;
    const last = page.threads.last();
    const next = byArchiveTime ? last.archiveTimestamp : last.id;
    if (next === before) return; // cursor didn't advance; don't spin
    before = next;
  }
}

/**
 * Yield every thread of `channel` that could contain a message at or after
 * `sinceMs`: all active threads, plus archived ones still in the window.
 * Private archived threads are listed in full when the bot can Manage Threads,
 * otherwise only the ones it has joined.
 */
async function* threadsSince(channel, sinceMs) {
  if (!channel.threads) return; // voice/stage/DM: no threads
  const seen = new Set();

  const { threads: active } = await channel.threads.fetchActive();
  for (const thread of active.values()) {
    seen.add(thread.id);
    yield thread;
  }

  const canManageThreads = channel
    .permissionsFor(channel.client.user)
    ?.has(PermissionFlagsBits.ManageThreads);
  const listings = [
    { type: "public" },
    { type: "private", fetchAll: Boolean(canManageThreads) },
  ];
  for (const listing of listings) {
    try {
      for await (const thread of archivedThreadsSince(channel, listing, sinceMs)) {
        if (seen.has(thread.id)) continue; // archived mid-walk after being listed as active
        seen.add(thread.id);
        yield thread;
      }
    } catch (err) {
      console.warn(
        `#${channel.name}: could not list ${listing.type} archived threads: ${err.message}`,
      );
    }
  }
}

/**
 * Yield every message in `channel` and its threads posted at or after
 * `sinceMs`. A thread the bot can't read is skipped, not fatal. If `stats` is
 * given it is filled in as the walk goes: { threads, skippedThreads }.
 */
export async function* messagesSince(channel, sinceMs, stats = {}) {
  stats.threads = 0;
  stats.skippedThreads = 0;

  // Forum/media channels have no top-level messages, only threads.
  if (channel.messages) yield* historySince(channel, sinceMs);

  for await (const thread of threadsSince(channel, sinceMs)) {
    try {
      yield* historySince(thread, sinceMs);
      stats.threads += 1;
    } catch (err) {
      stats.skippedThreads += 1;
      console.warn(`Skipping thread "${thread.name}" (${thread.id}): ${err.message}`);
    }
  }
}
