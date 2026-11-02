import { BackgroundOwnership, type BackgroundEpoch } from './background-ownership.js';
import { lockCornerLifecycle } from './corner-lifecycle.js';
import { closeExpiredChoiceVersion } from './room-choice.js';
import { ROUTER_AUTHORITY_LOCK } from './router-projection-schema.js';
import type { TrayClockClaim } from './tray-clock-source.js';

type ChoiceDeadline = TrayClockClaim & { kind: 'choice-close'; remainingMs: number };
type Candidate = Omit<ChoiceDeadline, 'remainingMs'> & { choiceId: string; roomId: string; workspaceId: string; parentId: string | null };
export type TrayChoiceDrain = Readonly<{ consumed: boolean; next: ChoiceDeadline | null; continuation: boolean }>;

/** Unselected adapter for the actual existing choice terminal transition.
 * One source per transaction avoids acquiring multiple corner lifecycle locks
 * after authority. Only a returned actual due source admits continuation; a
 * busy/failed transaction supplies neither a retry nor another deadline. */
export class TrayChoiceClockOwner {
  constructor(private readonly ownership: BackgroundOwnership) {}

  drain(epoch: BackgroundEpoch): Promise<TrayChoiceDrain> {
    return this.ownership.withTransaction(epoch, 'tray.expire', async db => {
      const planned = (await db.query<Candidate>(`SELECT deadline.id,deadline.incarnation,deadline.revision::text,deadline.kind,
        to_char(deadline.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dueAt",
        deadline.source_id AS "choiceId",room.id AS "roomId",room.workspace_id AS "workspaceId",room.parent_id AS "parentId"
        FROM tray_clock_deadlines deadline JOIN room_choices choice ON choice.id::text=deadline.source_id
        JOIN rooms room ON room.id=choice.room_id
        WHERE deadline.state='pending' AND deadline.kind='choice-close' AND deadline.due_at<=clock_timestamp()
        ORDER BY deadline.due_at,deadline.id LIMIT 1`)).rows[0];
      let consumed = false;
      if (planned) {
        if (planned.parentId) await lockCornerLifecycle(db, planned.roomId);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
        // Legacy expiry/decision paths can hold a source before their trigger
        // requests authority. Never wait on that inverse order.
        const source = (await db.query<{ room_id: string; workspace_id: string; room_workspace_id: string; parent_id: string | null;
          message_id: string; status: string; expiry_version: string }>(`SELECT choice.room_id,choice.workspace_id,
          room.parent_id,room.workspace_id room_workspace_id,choice.message_id,choice.status,choice.closes_at::text expiry_version
          FROM room_choices choice JOIN rooms room ON room.id=choice.room_id
          WHERE choice.id::text=$1 FOR UPDATE OF choice NOWAIT`, [planned.choiceId])).rows[0];
        if (source && source.status === 'open') {
          if (source.room_id !== planned.roomId || source.workspace_id !== planned.workspaceId ||
              source.room_workspace_id !== planned.workspaceId || source.parent_id !== planned.parentId)
            throw new Error('Tray choice source moved');
          if (!(await db.query('SELECT id FROM messages WHERE id=$1 AND room_id=$2 FOR UPDATE NOWAIT',
            [source.message_id,planned.roomId])).rowCount) throw new Error('Tray choice message moved');
          const current = await db.query(`SELECT id FROM tray_clock_deadlines
            WHERE id=$1 AND incarnation=$2 AND revision=$3::bigint AND state='pending'
              AND kind='choice-close' AND source_id=$4 AND workspace_id=$5 AND room_id=$6
              AND due_at=$7::timestamptz AND due_at= $8::timestamptz AND due_at<=clock_timestamp()
            FOR UPDATE NOWAIT`, [planned.id,planned.incarnation,planned.revision,planned.choiceId,
            planned.workspaceId,planned.roomId,planned.dueAt,source.expiry_version]);
          if (current.rowCount) {
            consumed = await closeExpiredChoiceVersion(db, planned.choiceId, source.expiry_version);
            if (consumed) await db.query('UPDATE tray_clock_state SET revision=revision+1 WHERE workspace_id=$1', [planned.workspaceId]);
          }
        }
      }
      const next = (await db.query<ChoiceDeadline>(`SELECT id,incarnation,revision::text,kind,
        to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dueAt",
        EXTRACT(epoch FROM (due_at-clock_timestamp()))::double precision*1000 AS "remainingMs"
        FROM tray_clock_deadlines WHERE state='pending' AND kind='choice-close' ORDER BY due_at,id LIMIT 1`)).rows[0];
      if (next && next.remainingMs <= 0 && (!planned || !consumed && next.id === planned.id &&
          next.incarnation === planned.incarnation && next.revision === planned.revision))
        throw new Error('Tray choice source unavailable');
      return Object.freeze({ consumed, next: next ? Object.freeze(next) : null,
        continuation: next !== undefined && next.remainingMs <= 0 });
    });
  }
}
