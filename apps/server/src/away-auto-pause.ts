import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';

/** Called only by successful person-facing writes, never message delivery. */
export async function recordPersonInteraction(db: SqlDatabase, personId: string): Promise<void> {
  await db.query(`UPDATE identities SET last_app_active_at=clock_timestamp(),away_warning_at=NULL
    WHERE id=$1 AND kind='human' AND NOT hidden_from_roster`, [personId]);
}

// Timers belonging to a running workflow are engine obligations, not wake sources.
const activeWork = `SELECT schedule.room_id,agent.owner_id FROM agent_schedules schedule
  JOIN agents agent ON agent.agent_id=schedule.agent_id
  JOIN rooms room ON room.id=schedule.room_id AND room.archived_at IS NULL
  JOIN room_access member ON member.room_id=schedule.room_id AND member.identity_id=schedule.agent_id AND member.removed_at IS NULL
  WHERE schedule.paused_at IS NULL AND schedule.workflow_run IS NULL
  UNION SELECT subscription.room_id,agent.owner_id FROM agent_subscriptions subscription
  JOIN agents agent ON agent.agent_id=subscription.agent_id
  JOIN rooms room ON room.id=subscription.room_id AND room.archived_at IS NULL
  JOIN room_access member ON member.room_id=subscription.room_id AND member.identity_id=subscription.agent_id AND member.removed_at IS NULL
  WHERE subscription.paused_at IS NULL`;
const deadline = `COALESCE(person.away_warning_at+interval '1 day',
  person.last_app_active_at+interval '3 days')`;

/** Shares the scheduler's existing deadline and committed-change wake. */
export async function nextAwayPauseDelay(db: SqlDatabase): Promise<number | undefined> {
  return (await db.query<{ delay_ms: number }>(`SELECT greatest(0,ceil(extract(epoch FROM
    (min(${deadline})-clock_timestamp()))*1000))::float8 delay_ms
    FROM identities person WHERE person.kind='human' AND NOT person.hidden_from_roster
      AND EXISTS(SELECT 1 FROM (${activeWork}) work WHERE work.owner_id=person.id) HAVING min(${deadline}) IS NOT NULL`)).rows[0]?.delay_ms ?? undefined;
}

export async function pauseAwayWork(db: SqlDatabase, now: Date, onPosted?: (roomId: string) => void): Promise<void> {
  const people = await db.query<{ id: string }>(`SELECT person.id FROM identities person
    WHERE person.kind='human' AND NOT person.hidden_from_roster AND ${deadline}<=$1
      AND EXISTS(SELECT 1 FROM (${activeWork}) work WHERE work.owner_id=person.id)`, [now]);
  for (const person of people.rows) {
    const rooms = await db.transaction(async tx => {
      // Serialize the decision with interaction; recheck after acquiring the lock.
      const current = (await tx.query<{ away_warning_at: Date | null; handle: string | null; name: string }>(
        `SELECT away_warning_at,handle,name FROM identities person
         WHERE person.id=$1 AND ${deadline}<=$2 FOR UPDATE`, [person.id, now])).rows[0];
      if (!current) return [];
      const rooms = (await tx.query<{ room_id: string }>(`SELECT DISTINCT work.room_id FROM (${activeWork}) work
        WHERE work.owner_id=$1`, [person.id])).rows;
      if (!rooms.length) return [];
      if (current.away_warning_at) {
        await tx.query(`UPDATE agent_schedules SET paused_at=$2,updated_at=$2
          WHERE paused_at IS NULL AND workflow_run IS NULL
            AND agent_id IN (SELECT agent_id FROM agents WHERE owner_id=$1)`, [person.id, now]);
        await tx.query(`UPDATE agent_subscriptions SET paused_at=$2 WHERE paused_at IS NULL
          AND agent_id IN (SELECT agent_id FROM agents WHERE owner_id=$1)`, [person.id, now]);
      } else {
        await tx.query('UPDATE identities SET away_warning_at=$2 WHERE id=$1', [person.id, now]);
        await ensureSystemIdentity(tx);
        for (const room of rooms) await systemLine(tx, {
          roomId: room.room_id, authorId: SYSTEM_IDENTITY_ID,
          subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: 'Beeline' },
          verb: systemMessage('away-auto-pause.warning'),
          object: { text: current.handle ? `@${current.handle}` : current.name, id: person.id },
          consequence: systemMessage('away-auto-pause.come-back'),
          presentation: 'card', cardType: 'away-warning', card: { ownerId: person.id },
        });
      }
      return rooms.map(room => room.room_id);
    });
    for (const room of rooms) onPosted?.(room);
  }
}
