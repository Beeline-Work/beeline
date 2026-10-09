import type { SqlDatabase } from './database.js';

/** How long a view outlives the server that holds its socket, should that server die. */
const VIEW_LEASE_SECONDS = 90;
/** Renewal runs well inside the lease, and only while some socket views a Room. */
export const VIEW_RENEW_INTERVAL_MS = 30_000;

/**
 * Which Rooms each phone live socket is viewing, for the push gate
 * (`room_push_views`, read by `PushDeliveryLoop`). The phone says so once
 * when a Room comes on screen and once when it leaves; a view ends with the
 * socket that carried it. The server, not the phone, keeps the lease alive,
 * so a viewing phone sends nothing while it sits on a Room.
 */
export class PhoneViewing {
  private readonly sessions = new Map<string, { identityId: string; rooms: Set<string> }>();
  private renewal: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly database: Pick<SqlDatabase, 'query'>) {}

  async view(sessionId: string, identityId: string, roomId: string, viewing: boolean): Promise<void> {
    if (!viewing) {
      const session = this.sessions.get(sessionId);
      if (!session?.rooms.delete(roomId)) return;
      if (session.rooms.size === 0) this.sessions.delete(sessionId);
      this.stopRenewalWhenIdle();
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
      `INSERT INTO room_push_views(room_id,identity_id,session_id,expires_at)
       SELECT member.room_id,member.identity_id,$3,now()+make_interval(secs=>$4)
       FROM memberships member
       JOIN identities person ON person.id=member.identity_id AND person.kind='human'
       WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL
       ON CONFLICT(room_id,identity_id,session_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
      [roomId, identityId, sessionId, VIEW_LEASE_SECONDS],
    );
    if (this.sessions.get(sessionId) !== session) {
      // The socket closed while this view was being written.
      await this.database.query(`DELETE FROM room_push_views WHERE session_id=$1`, [sessionId]);
      return;
    }
    if (!inserted.rowCount) {
      session.rooms.delete(roomId);
      if (session.rooms.size === 0) this.sessions.delete(sessionId);
      this.stopRenewalWhenIdle();
      return;
    }
    if (!this.renewal) {
      this.renewal = setInterval(
        () => void this.renew().catch(() => undefined),
        VIEW_RENEW_INTERVAL_MS,
      );
      this.renewal.unref?.();
    }
  }

  /** The socket closed: every Room it was viewing stops holding pushes. */
  async end(sessionId: string): Promise<void> {
    if (!this.sessions.delete(sessionId)) return;
    this.stopRenewalWhenIdle();
    await this.database.query(`DELETE FROM room_push_views WHERE session_id=$1`, [sessionId]);
  }

  async renew(): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    if (sessionIds.length === 0) return;
    await this.database.query(
      `UPDATE room_push_views SET expires_at=now()+make_interval(secs=>$2)
       WHERE session_id=ANY($1::text[])`,
      [sessionIds, VIEW_LEASE_SECONDS],
    );
  }

  dispose(): void {
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = undefined;
  }

  private stopRenewalWhenIdle(): void {
    if (this.sessions.size > 0 || !this.renewal) return;
    clearInterval(this.renewal);
    this.renewal = undefined;
  }
}
