import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { directMessageRoomId } from './system-line.js';
import { recordFreeAgentEvent } from './free-agents.js';

/** Deliver independently of model output, serialized with owner usage settlement. */
export async function warnFreeAgentOwner(
  database: SqlDatabase,
  agentId: string,
  ownerId: string,
  day: string,
  dailyTokenCap: number,
): Promise<void> {
  await database.transaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`free-agent-usage:${ownerId}`]);
    // Usage totals include in-flight reservations. Only settled charges can warn.
    const used = (await db.query<{ tokens: string }>(
      `SELECT COALESCE(SUM((event.detail->>'tokens')::bigint),0) tokens
       FROM free_agent_events event JOIN free_agents free ON free.agent_id=event.agent_id
       WHERE free.owner_id=$1 AND event.kind='model_usage' AND event.detail->>'day'=$2
         AND event.at>=($2::date::timestamp AT TIME ZONE 'UTC')
         AND event.at<($2::date::timestamp AT TIME ZONE 'UTC')+interval '2 days'`, [ownerId, day],
    )).rows[0];
    if (dailyTokenCap <= 0 || !used || Number(used.tokens) < dailyTokenCap * 0.8) return;
    const agent = (await db.query<{ workspace_id: string }>(
      `SELECT free.workspace_id FROM free_agents free
       WHERE free.agent_id=$1 AND free.owner_id=$2
       AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=free.workspace_id
         AND m.room_id IS NULL AND m.identity_id=$2 AND m.removed_at IS NULL)`, [agentId, ownerId],
    )).rows[0];
    if (!agent) return;
    const id = createHash('sha256').update(`free-agent-warning:${ownerId}:${day}`).digest('hex');
    if ((await db.query(`SELECT 1 FROM messages WHERE id=$1`, [id])).rowCount) return;
    const participants = [ownerId, agentId].sort() as [string, string];
    const existing = (await db.query<{ id: string }>(
      `SELECT id FROM rooms WHERE workspace_id=$1 AND direct_participants=$2::jsonb`,
      [agent.workspace_id, JSON.stringify(participants)],
    )).rows[0];
    const roomId = existing?.id ?? directMessageRoomId(agent.workspace_id, participants);
    await db.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
       VALUES($1,$2,$3,'Direct message','invite-only',$4::jsonb) ON CONFLICT DO NOTHING`,
      [roomId, agent.workspace_id, ownerId, JSON.stringify(participants)],
    );
    for (const member of participants) await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')
       ON CONFLICT(room_id,identity_id) WHERE room_id IS NOT NULL DO UPDATE SET removed_at=NULL`,
      [agent.workspace_id, roomId, member],
    );
    const link = `https://web.usebeeline.app/beeline/members?communityId=${encodeURIComponent(agent.workspace_id)}&action=add-agent`;
    const text = `I've used 80% of today's free allowance. It resets at midnight UTC. Want help running and connecting your own agent on your computer or an always-on machine? Open [Members -> Add agent](${link}) to get started.`;
    const inserted = await db.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [id, roomId, agentId, text],
    );
    if (!inserted.rowCount) return;
    await db.query(`DELETE FROM chat_dismissals WHERE room_id=$1 AND identity_id=$2`, [roomId, ownerId]);
    await recordFreeAgentEvent(db, agentId, 'allowance_warning', { day, ownerId, roomId, messageId: id });
    await recordFreeAgentEvent(db, agentId, 'nudge_shown', { day, ownerId, source: 'allowance_warning' });
  });
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
  await database.transaction(async db => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`free-agent-guide:${ownerId}:${workspaceId}`]);
    await db.query(`INSERT INTO free_agent_events(agent_id,kind,detail)
    SELECT free.agent_id,'guide_started',jsonb_build_object('source','add_agent_command','warningId',warning.id)
    FROM free_agents free JOIN LATERAL (
      SELECT event.id FROM free_agent_events event WHERE event.agent_id=free.agent_id
        AND event.kind='allowance_warning' AND event.at>=now()-interval '24 hours'
      ORDER BY event.at DESC,event.id DESC LIMIT 1
    ) warning ON true
    WHERE free.owner_id=$1 AND free.workspace_id=$2
      AND NOT EXISTS(SELECT 1 FROM free_agent_events started WHERE started.agent_id=free.agent_id
        AND started.kind='guide_started' AND started.detail->>'warningId'=warning.id::text)`,
    [ownerId, workspaceId]);
  });
}
