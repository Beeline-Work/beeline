import type { RoomHistoryOutline } from '@beeline/api-contract/phone';
import type { LiveHub } from './live.js';

/** Enough for every Room people have open on one server; least recently read goes first. */
const MAX_CACHED_ROOMS = 256;

type Entry = { readonly newestId: string | null; readonly outline: RoomHistoryOutline };

/**
 * Room history outlines, per Room and time zone, kept while the Room's
 * messages are unchanged. Every insert, update, or delete on `messages` fires
 * the `postgres:messages` notification on every server, which drops that
 * Room. A listener reconnect or a dropped notification backlog resyncs, which
 * drops every Room. A read also compares the Room's newest message, so a new
 * message is never served from an older entry. The caller checks access
 * before it asks.
 */
export class HistoryOutlineCache {
  private readonly rooms = new Map<string, Map<string, Entry>>();
  /** Reads computing now; an invalidation while one runs keeps it out of the cache. */
  private readonly reads = new Set<{ readonly roomId: string; stale: boolean }>();

  constructor(live: LiveHub) {
    live.subscribeAll((event) => {
      if (event.type === 'invalidate' && event.reason === 'postgres:messages')
        this.invalidate(event.roomId);
    });
    live.subscribeResync(() => this.clear());
  }

  async read(
    roomId: string,
    timeZone: string,
    newestId: string | null,
    compute: () => Promise<RoomHistoryOutline>,
  ): Promise<RoomHistoryOutline> {
    const zones = this.rooms.get(roomId);
    const cached = zones?.get(timeZone);
    if (zones && cached && cached.newestId === newestId) {
      this.rooms.delete(roomId);
      this.rooms.set(roomId, zones);
      return cached.outline;
    }
    const read = { roomId, stale: false };
    this.reads.add(read);
    try {
      const outline = await compute();
      if (!read.stale) this.store(roomId, timeZone, { newestId, outline });
      return outline;
    } finally {
      this.reads.delete(read);
    }
  }

  private store(roomId: string, timeZone: string, entry: Entry): void {
    const zones = this.rooms.get(roomId) ?? new Map<string, Entry>();
    this.rooms.delete(roomId);
    zones.set(timeZone, entry);
    this.rooms.set(roomId, zones);
    if (this.rooms.size > MAX_CACHED_ROOMS)
      this.rooms.delete(this.rooms.keys().next().value!);
  }

  private invalidate(roomId: string): void {
    this.rooms.delete(roomId);
    for (const read of this.reads) if (read.roomId === roomId) read.stale = true;
  }

  private clear(): void {
    this.rooms.clear();
    for (const read of this.reads) read.stale = true;
  }
}
