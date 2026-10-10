import type { SqlDatabase } from './database.js';
import { SERVER_LEASE_EXPIRY_MS } from './connection-presence.js';

/** Remove socket views left by an earlier process on this machine or a dead peer. */
export async function clearStalePhoneViews(database: Pick<SqlDatabase, 'query'>, instanceId: string): Promise<void> {
  await database.query(
    `DELETE FROM room_push_views view
     WHERE view.instance_id IS NOT NULL AND (
       view.instance_id=$1
       OR split_part(view.instance_id,':',1)=split_part($1,':',1)
       OR NOT EXISTS (
         SELECT 1 FROM live_server_instances server
         WHERE server.instance_id=view.instance_id
           AND server.renewed_at>clock_timestamp()-make_interval(secs=>$2::double precision/1000)
       )
     )`,
    [instanceId, SERVER_LEASE_EXPIRY_MS],
  );
}

/**
 * Which Rooms each phone live socket is viewing, for the push gate
 * (`room_push_views`, read by `PushDeliveryLoop`). The phone says so once
 * when a Room comes on screen and once when it leaves; a view ends with the
 * socket that carried it. The server's existing instance record lets another
 * machine distinguish a live socket from one abandoned by a crashed process.
 */
export class PhoneViewing {
  private readonly sessions = new Map<string, { identityId: string; rooms: Set<string> }>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly database: Pick<SqlDatabase, 'query'>, private readonly instanceId: string) {}

  view(sessionId: string, identityId: string, roomId: string, viewing: boolean): Promise<void> {
    return this.track(this.setView(sessionId, identityId, roomId, viewing));
  }

  private async setView(sessionId: string, identityId: string, roomId: string, viewing: boolean): Promise<void> {
    if (!viewing) {
      const session = this.sessions.get(sessionId);
      if (!session?.rooms.delete(roomId)) return;
      if (session.rooms.size === 0) this.sessions.delete(sessionId);
      await this.database.query(
        `DELETE FROM room_push_views WHERE room_id=$1 AND identity_id=$2 AND session_id=$3`,
        [roomId, identityId, sessionId],
      );
      return;
    }
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { identityId, rooms: new Set<string>() };
      this.sessions.set(sessionId, session);
    }
    session.rooms.add(roomId);
    // Only a current human member's view holds that member's pushes.
    const inserted = await this.database.query(
      `INSERT INTO room_push_views(room_id,identity_id,session_id,instance_id,expires_at)
       SELECT member.room_id,member.identity_id,$3,$4,NULL
       FROM memberships member
       JOIN identities person ON person.id=member.identity_id AND person.kind='human'
       WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL
       ON CONFLICT(room_id,identity_id,session_id) DO UPDATE
         SET instance_id=EXCLUDED.instance_id,expires_at=NULL`,
      [roomId, identityId, sessionId, this.instanceId],
    );
    if (this.sessions.get(sessionId) !== session) {
      // The socket closed while this view was being written.
      await this.database.query(`DELETE FROM room_push_views WHERE session_id=$1`, [sessionId]);
      return;
    }
    if (!inserted.rowCount) {
      session.rooms.delete(roomId);
      if (session.rooms.size === 0) this.sessions.delete(sessionId);
      return;
    }
  }

  /** The socket closed: every Room it was viewing stops holding pushes. */
  end(sessionId: string): Promise<void> {
    return this.track(this.release(sessionId));
  }

  private async release(sessionId: string): Promise<void> {
    if (!this.sessions.delete(sessionId)) return;
    await this.database.query(`DELETE FROM room_push_views WHERE session_id=$1`, [sessionId]);
  }

  /** Graceful shutdown waits for close handlers and in-flight viewing writes. */
  async endAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.end(sessionId)));
    await Promise.all([...this.pending]);
  }

  private track(task: Promise<void>): Promise<void> {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => undefined);
    return task;
  }
}
