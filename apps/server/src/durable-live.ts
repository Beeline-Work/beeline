import type { SqlDatabase } from './database.js';
import type { LiveEvent, LiveHub } from './live.js';

export const LIVE_REPLAY_LIMIT = 1024;
export type LiveCursor = { epoch: string; base: number; seen: readonly number[] };
type Entry = { sequence: number; event: LiveEvent };

/** ID-only invalidations commit with their source rows. The stream row lock
 * orders cursors by commit, rather than by sequence allocation time. */
export const DURABLE_LIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS live_streams (
  id text PRIMARY KEY, epoch text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
  sequence bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS live_journal (
  stream_id text NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  sequence bigint NOT NULL, event jsonb NOT NULL,
  PRIMARY KEY(stream_id,sequence)
);
CREATE OR REPLACE FUNCTION beeline_journal(stream text, body jsonb) RETURNS void AS $$
DECLARE position bigint;
BEGIN
  INSERT INTO live_streams(id,sequence) VALUES(stream,1)
    ON CONFLICT(id) DO UPDATE SET sequence=live_streams.sequence+1
    RETURNING sequence INTO position;
  INSERT INTO live_journal(stream_id,sequence,event) VALUES(stream,position,body);
  DELETE FROM live_journal WHERE stream_id=stream AND sequence<=position-${LIVE_REPLAY_LIMIT};
END;
$$ LANGUAGE plpgsql;
`;

export function readLiveCursor(value: unknown): LiveCursor | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Partial<LiveCursor>;
  if (typeof item.epoch !== 'string' || item.epoch.length > 128 ||
      !Number.isSafeInteger(item.base) || item.base! < 0 || !Array.isArray(item.seen) ||
      item.seen.length > LIVE_REPLAY_LIMIT ||
      !item.seen.every(n => Number.isSafeInteger(n) && n > item.base!)) return;
  return item as LiveCursor;
}

export class DurableLiveReplay {
  constructor(private readonly database: SqlDatabase, private readonly live: LiveHub) {}

  async read(stream: string, cursor?: LiveCursor) {
    // One statement snapshot includes both the head and its retained entries.
    const result = await this.database.query<{
      epoch: string; head: string; sequence: string | null; event: LiveEvent | null;
    }>(`SELECT s.epoch,s.sequence::text head,j.sequence::text,j.event
        FROM live_streams s LEFT JOIN live_journal j
          ON j.stream_id=s.id AND j.sequence>$2 AND s.epoch=$4
            AND $2>=s.sequence-${LIVE_REPLAY_LIMIT}
        WHERE s.id=$1 ORDER BY j.sequence LIMIT $3`,
      [stream, cursor?.base ?? 0, LIVE_REPLAY_LIMIT + 1, cursor?.epoch ?? '']);
    const first = result.rows[0];
    if (!first) return { epoch: '', sequence: 0, resumed: false, replay: [] as Entry[] };
    const head = Number(first.head);
    const rows = result.rows.filter(row => row.sequence !== null);
    const resumed = Boolean(cursor && cursor.epoch === first.epoch &&
      Number.isSafeInteger(head) && cursor.base <= head &&
      head - cursor.base <= LIVE_REPLAY_LIMIT &&
      rows.length === head - cursor.base &&
      cursor.seen.every(n => n <= head));
    const seen = new Set(cursor?.seen);
    return { epoch: first.epoch, sequence: head, resumed,
      replay: resumed ? rows.filter(row => !seen.has(Number(row.sequence)))
        .map(row => ({ sequence: Number(row.sequence), event: row.event! })) : [] };
  }

  async subscribe(
    stream: string, roomId: string, cursor: LiveCursor | undefined,
    deliver: (event: LiveEvent, sequence?: number, epoch?: string) => void | Promise<void>,
    checkpoint: (sequence: number, epoch: string, reload: boolean) => void,
    authorize: () => Promise<boolean>,
  ) {
    let stopped = false, active = false, dirty = false, running = false;
    let position: LiveCursor | undefined;
    const drain = async () => {
      if (!active || running || stopped) return;
      running = true;
      try {
        while (dirty && !stopped) {
          dirty = false;
          if (!await authorize()) { checkpoint(0, '', true); release(); break; }
          const next = await this.read(stream, position);
          if (stopped) break;
          if (!next.resumed) checkpoint(next.sequence, next.epoch, true);
          else for (const entry of next.replay) {
            if (stopped) break;
            await deliver(entry.event, entry.sequence, next.epoch);
            if (!stopped) checkpoint(entry.sequence, next.epoch, false);
          }
          position = { epoch: next.epoch, base: next.sequence, seen: [] };
        }
      } catch {
        // A failed query is never acknowledged as caught up.
        if (!stopped) checkpoint(0, '', true);
        release();
      } finally { running = false; }
    };
    // Subscribe before reading the head; writes racing that read mark dirty.
    const unlisten = this.live.subscribeJournal(streams => {
      if (!streams.includes(stream)) return;
      dirty = true;
      void drain();
    });
    const unoverlay = this.live.subscribe(roomId, event => {
      if (stream.startsWith('room:') && event.type !== 'invalidate') {
        if (active && !stopped) void deliver(event);
      }
    });
    const unresync = this.live.subscribeResync(() => { dirty = true; void drain(); });
    const release = () => { stopped = true; unlisten(); unoverlay(); unresync(); };
    try {
      // Empty Rooms need a durable epoch before their first mutation.
      await this.database.query(`INSERT INTO live_streams(id) VALUES($1) ON CONFLICT DO NOTHING`, [stream]);
      const initial = await this.read(stream, cursor);
      position = { epoch: initial.epoch, base: initial.sequence, seen: [] };
      return { ...initial, release, start: () => { active = true; void drain(); } };
    } catch (error) { release(); throw error; }
  }
}
