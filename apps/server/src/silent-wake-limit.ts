import { createHash } from 'node:crypto';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { systemLine } from './system-line.js';

const SILENT_WAKE_LIMIT = 3;

/** Only automatic reminders and tool continuations belong to this breaker. */
export function isSilentRetry(reason: string, payload?: { automatic?: boolean } | null): boolean {
  return reason === 'corner_background_tool' || reason === 'report' && payload?.automatic === true;
}

/** Called in the dispatch/receipt transaction. The original human message is the episode key. */
export async function stopSilentWakes(db: SqlDatabase, roomId: string, agentId: string, root: string): Promise<boolean> {
  const count = await db.query(`SELECT 1 FROM agent_commands command JOIN agent_turns turn
      ON turn.room_id=command.room_id AND turn.agent_id=command.agent_id AND turn.request_id=command.turn_request_id
    WHERE command.room_id=$1 AND command.agent_id=$2 AND command.root_source_message_id=$3
      AND (turn.status IN ('complete','failed') OR turn.completion_kind='no-reply')
      AND (command.reason='corner_background_tool' OR command.reason='report' AND command.private_payload->>'automatic'='true')
      AND NOT EXISTS(SELECT 1 FROM messages reply WHERE reply.room_id=$1 AND reply.author_id=$2
        AND reply.request_id=command.turn_request_id AND reply.presentation='message' AND reply.deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM messages reply JOIN agent_commands answered ON answered.turn_request_id=reply.request_id
        AND answered.agent_id=reply.author_id AND answered.room_id=reply.room_id
        WHERE answered.root_source_message_id=$3 AND reply.author_id=$2 AND reply.room_id=$1
          AND reply.presentation='message' AND reply.deleted_at IS NULL AND reply.created_at>=command.created_at)
    LIMIT ${SILENT_WAKE_LIMIT}`, [roomId,agentId,root]);
  if (count.rows.length < SILENT_WAKE_LIMIT) return false;
  await db.query(`WITH cancelled AS (UPDATE agent_commands SET state='cancelled',completed_at=now(),cancellation_reason='silent_wake_limit'
    WHERE room_id=$1 AND agent_id=$2 AND root_source_message_id=$3 AND state='pending'
      AND (reason='corner_background_tool' OR reason='report' AND private_payload->>'automatic'='true')
    RETURNING id,room_id,agent_id,turn_request_id)
    UPDATE agent_turns turn SET status='cancelled',created_at=now()
    FROM cancelled command WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
      AND turn.request_id=command.turn_request_id AND turn.status='working'
      AND turn.generation_id='pending:'||command.id`, [roomId,agentId,root]);
  const source = (await db.query<{ room_id: string; name: string }>(`SELECT source.room_id,agent.name
    FROM messages source JOIN identities person ON person.id=source.author_id AND person.kind='human'
    JOIN identities agent ON agent.id=$2 WHERE source.id=$1 AND source.deleted_at IS NULL AND person.id<>$3
      AND source.presentation='message' AND source.system_event IS NULL`, [root,agentId,SYSTEM_IDENTITY_ID])).rows[0];
  if (source) await systemLine(db, {
    id: createHash('sha256').update(`silent-wake-limit:${roomId}:${agentId}:${root}`).digest('hex'),
    roomId: source.room_id, afterMessageId: root,
    subject: { kind: 'agent', id: agentId, name: source.name },
    verb: systemMessage('turn-silence.could-not-answer'),
    consequence: systemMessage('free-agent-turn-close.say-continue-to-pick-up-where-work-stopped'),
    cardType: 'turn-failed', card: { agentId, requestId: root, silentWakeLimit: true },
  });
  return true;
}
