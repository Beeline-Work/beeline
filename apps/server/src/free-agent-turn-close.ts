import type { SqlDatabase } from './database.js';
import { systemLine, restateSystemLine } from './system-line.js';

/** Call in the terminal writer's transaction. Returns true for a free agent. */
export async function closeFreeAgentTurn(database: SqlDatabase, input: {
  roomId: string; requestId: string; agentId: string;
  generationId?: string | null; reason?: string | null; reasonKind?: string;
  normal?: boolean;
}): Promise<boolean> {
  if (input.reasonKind === 'update-interrupted') return false;
  const agent = (await database.query<{ name: string }>(
    `SELECT identity.name FROM free_agents free JOIN identities identity ON identity.id=free.agent_id
     WHERE free.agent_id=$1 AND free.removed_at IS NULL`, [input.agentId],
  )).rows[0];
  if (!agent) return false;
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,
    [`silence:${input.roomId}:${input.requestId}:${input.agentId}`]);
  const command = (await database.query<{
    generation_id: string | null; cancellation_reason: string | null;
    completion_kind: string | null; allowance: string | null;
    private_payload: unknown; review_context: unknown; passive: boolean;
  }>(`SELECT command.generation_id,command.cancellation_reason,turn.completion_kind,
      command.private_payload,command.review_context,source.system_event->>'kind'='computer-session-activity' passive,
      (SELECT event.detail->>'limit' FROM free_agent_events event
       WHERE event.agent_id=command.agent_id AND event.kind='allowance_reached'
         AND event.detail->>'roomId'=command.room_id::text
         AND event.detail->>'requestId'=command.turn_request_id
         AND event.at>=COALESCE(turn.started_at,command.claimed_at,command.created_at)
         AND event.at<=COALESCE(command.completed_at,now()) ORDER BY event.at DESC LIMIT 1) allowance
    FROM agent_commands command LEFT JOIN agent_turns turn ON turn.room_id=command.room_id
      AND turn.agent_id=command.agent_id AND turn.request_id=command.turn_request_id
    LEFT JOIN messages source ON source.id=command.source_message_id
    WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
      AND command.action IN ('input','resume') ORDER BY command.created_at DESC LIMIT 1 FOR UPDATE OF command`,
    [input.roomId,input.agentId,input.requestId])).rows[0];
  // Assignments and dispatched reviews keep the commander failure/report path.
  if (command?.private_payload || command?.review_context) return false;
  if (!command || (input.generationId != null && command.generation_id !== input.generationId) ||
      (command.cancellation_reason && command.cancellation_reason !== 'free-agent-time-limit') ||
      command.completion_kind === 'no-reply' || command.passive) return true;
  if ((await database.query(`SELECT 1 FROM messages WHERE room_id=$1 AND request_id=$2
    AND author_id=$3 AND presentation='message' AND deleted_at IS NULL LIMIT 1`,
    [input.roomId,input.requestId,input.agentId])).rowCount) return true;
  if (!input.normal) {
    await database.query(`UPDATE agent_turns SET status='failed',failure_reason=$4,created_at=now()
      WHERE room_id=$1 AND request_id=$2 AND agent_id=$3 AND status='working'`,
      [input.roomId,input.requestId,input.agentId,input.reason ?? 'runtime failure']);
    await database.query(`UPDATE agent_commands SET state='complete',completed_at=now()
      WHERE room_id=$1 AND turn_request_id=$2 AND agent_id=$3 AND state='claimed'
        AND generation_id IS NOT DISTINCT FROM $4`,
      [input.roomId,input.requestId,input.agentId,command.generation_id]);
  }
  const timeout = /free-agent-time-limit/.test(input.reason ?? '') ||
    command.cancellation_reason === 'free-agent-time-limit';
  const allowance = command.allowance || (input.reasonKind === 'allowance-spent' ? 'daily' : null);
  const crashed = /runtime_exited|lease expired|crash/i.test(input.reason ?? '');
  const phrase = {
    subject: { kind: 'agent' as const, id: input.agentId, name: agent.name },
    verb: allowance ? 'ran out of free allowance mid-task' : timeout ? 'hit the 15-minute limit' :
      input.normal ? 'ended without a reply' : crashed ? 'stopped after a runtime failure' : 'stopped before replying',
    consequence: allowance === 'lifetime' ? 'connect your own agent from Members to continue' : allowance ?
      'it resets at midnight UTC; ask to continue then' : 'say "continue" to pick up where work stopped',
  };
  const card = { requestId: input.requestId, agentId: input.agentId, state: 'failed',
    silenceKind: allowance ? 'allowance-spent' : 'hiccup', freeAgentClosed: true };
  const previous = (await database.query<{ id: string; closed: boolean | null }>(
    `SELECT id,(card->>'freeAgentClosed')::boolean closed FROM messages
     WHERE room_id=$1 AND card_type='turn-failed' AND card->>'requestId'=$2
       AND card->>'agentId'=$3 ORDER BY created_at DESC LIMIT 1`,
    [input.roomId,input.requestId,input.agentId])).rows[0];
  if (previous?.closed) return true;
  if (previous) await restateSystemLine(database, previous.id, phrase, card);
  else await systemLine(database, { roomId: input.roomId, ...phrase, cardType: 'turn-failed',
    card, afterMessageId: input.requestId });
  return true;
}
