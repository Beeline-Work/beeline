import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';

/**
 * Deliver independently of model output; the deterministic message ID claims delivery.
 * The plain reset-time notice goes in the room where the person is working, not
 * a separate DM, so it lands in the transcript they are already reading.
 */
export async function warnFreeAgentOwner(
  database: SqlDatabase,
  agentId: string,
  ownerId: string,
  day: string,
  dailyTokenCap: number,
  workingRoomId: string,
): Promise<void> {
  if (dailyTokenCap <= 0) return;
  const id = createHash('sha256').update(`free-agent-warning:${ownerId}:${day}`).digest('hex');
  await database.query(`WITH candidate AS (
    SELECT free.agent_id,free.workspace_id FROM free_agents free WHERE free.agent_id=$1 AND free.owner_id=$2
      AND EXISTS(SELECT 1 FROM memberships WHERE room_id=$4 AND identity_id=$2 AND removed_at IS NULL)
      AND (SELECT COALESCE(SUM((event.detail->>'tokens')::bigint),0)
        FROM free_agent_events event JOIN free_agents agent ON agent.agent_id=event.agent_id
        WHERE agent.owner_id=$2 AND event.kind='model_usage' AND event.detail->>'day'=$3
          AND event.at>=($3::date::timestamp AT TIME ZONE 'UTC')
          AND event.at<($3::date::timestamp AT TIME ZONE 'UTC')+interval '2 days')>=$5::numeric*0.8
  ), inserted AS (
    INSERT INTO messages(id,room_id,author_id,text)
    SELECT $6,$4,agent_id,$7 || workspace_id::text || $8 FROM candidate
    ON CONFLICT DO NOTHING RETURNING id,author_id
  ), undismissed AS (
    DELETE FROM chat_dismissals WHERE room_id=$4 AND identity_id=$2 AND EXISTS(SELECT 1 FROM inserted)
  ) INSERT INTO free_agent_events(agent_id,kind,detail)
    SELECT author_id,kind,jsonb_build_object('day',$3::text,'ownerId',$2::text) ||
      CASE WHEN kind='allowance_warning' THEN jsonb_build_object('roomId',$4::text,'messageId',id)
        ELSE jsonb_build_object('source','allowance_warning') END
    FROM inserted CROSS JOIN (VALUES('allowance_warning'),('nudge_shown')) notices(kind)`,
  [agentId,ownerId,day,workingRoomId,dailyTokenCap,id,
    "I've used 80% of today's free allowance. It resets at midnight UTC. Want help running and connecting your own agent on your computer or an always-on machine? Open [Members -> Add agent](https://web.usebeeline.app/beeline/members?communityId=",
    '&action=add-agent) to get started.']);
}

/** Pairing is a server-observed conversion; model-authored offers are not inferred. */
export async function recordAgentConnectedAfterNudge(
  db: SqlDatabase, ownerId: string, workspaceId: string, agentId: string,
): Promise<void> {
  await db.query(`INSERT INTO free_agent_events(agent_id,kind,detail)
    SELECT free.agent_id,'agent_connected_after_nudge',jsonb_build_object('connectedAgentId',$3::text)
    FROM free_agents free WHERE free.owner_id=$1 AND free.workspace_id=$2
      AND NOT EXISTS(SELECT 1 FROM free_agents own WHERE own.agent_id=$3)
      AND EXISTS(SELECT 1 FROM free_agent_events event WHERE event.agent_id=free.agent_id
        AND event.kind IN ('allowance_warning','nudge_shown') AND event.at>=now()-interval '24 hours')
      AND NOT EXISTS(SELECT 1 FROM free_agent_events event WHERE event.agent_id=free.agent_id
        AND event.kind='agent_connected_after_nudge' AND event.detail->>'connectedAgentId'=$3)`,
  [ownerId, workspaceId, agentId]);
}

/** A person reaching the real Add agent command is an observable guide start. */
export async function recordFreeAgentGuideStarted(database: SqlDatabase, ownerId: string, workspaceId: string): Promise<void> {
  await database.query(`INSERT INTO free_agent_events(agent_id,kind,detail)
    SELECT free.agent_id,'guide_started',jsonb_build_object('source','add_agent_command','warningId',warning.id)
    FROM free_agents free JOIN LATERAL (
      SELECT event.id FROM free_agent_events event WHERE event.agent_id=free.agent_id
        AND event.kind='allowance_warning' AND event.at>=now()-interval '24 hours'
      ORDER BY event.at DESC,event.id DESC LIMIT 1
    ) warning ON true
    WHERE free.owner_id=$1 AND free.workspace_id=$2
      AND NOT EXISTS(SELECT 1 FROM free_agent_events started WHERE started.agent_id=free.agent_id
        AND started.kind='guide_started' AND started.detail->>'warningId'=warning.id::text)
    ON CONFLICT DO NOTHING`,
    [ownerId, workspaceId]);
}
