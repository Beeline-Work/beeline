import { randomUUID } from 'node:crypto';
import type { AppConnectionJob, AppConnectionJobOutcome } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import { notifyConnectorAssignment } from './postgres-live.js';

async function loadAppConnectionJob(database: SqlDatabase, agentId: string, appId: string) {
  return (await database.query<{ job: AppConnectionJob | null }>(
    `SELECT squire_work->'appConnections'->$2 job FROM agents WHERE agent_id=$1`,
    [agentId, appId],
  )).rows[0]?.job ?? undefined;
}

export async function readAppConnectionJob(database: SqlDatabase, agentId: string, appId: string) {
  const job = await loadAppConnectionJob(database, agentId, appId);
  if (job?.outcome?.status === 'approval' && job.outcome.expiresAt && job.outcome.expiresAt <= Date.now())
    return { ...job, state: 'error' as const, outcome: { status: 'error' as const, reason: 'Squire approval expired. Reconnect to retry.' } };
  return job;
}

export async function queueAppConnectionJob(database: SqlDatabase, agentId: string,
  input: Omit<AppConnectionJob, 'jobId' | 'state' | 'outcome'>, reconnect: boolean) {
  await database.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`app-connection:${agentId}:${input.appId}`]);
  const existing = await readAppConnectionJob(database, agentId, input.appId);
  if (existing && existing.state !== 'ready' && !reconnect) return existing;
  const job: AppConnectionJob = { ...input, jobId: randomUUID(), state: 'queued' };
  await database.query(`UPDATE agents SET squire_work=jsonb_set(squire_work,
    '{appConnections}',COALESCE(squire_work->'appConnections','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb))
    WHERE agent_id=$1`, [agentId, input.appId, JSON.stringify(job)]);
  await notifyConnectorAssignment(database, agentId);
  return job;
}

export async function saveAppConnectionOutcome(database: SqlDatabase, agentId: string,
  appId: string, jobId: string, outcome: AppConnectionJobOutcome) {
  if (!outcome || !['ready', 'approval', 'error'].includes(outcome.status)) throw new Error('Connection outcome is invalid');
  const job = await loadAppConnectionJob(database, agentId, appId);
  if (!job || job.jobId !== jobId || (!['running', 'approval'].includes(job.state)
      && !(job.state === 'queued' && outcome.status === 'error')
      && JSON.stringify(job.outcome) !== JSON.stringify(outcome)))
    throw new Error('App connection job is no longer owned by this helper');
  const active = await database.query(`SELECT 1 FROM workspace_apps app
    JOIN agents agent ON agent.agent_id=$2 AND agent.owner_id=app.owner_identity_id
    JOIN rooms room ON room.id=$3 AND room.archived_at IS NULL
    JOIN agent_commands command ON command.id=$4 AND command.agent_id=$2 AND command.room_id=$3
    WHERE app.id=$1::uuid AND app.state='active' AND command.state<>'cancelled'
      AND EXISTS (SELECT 1 FROM memberships member WHERE member.room_id=$3
        AND member.identity_id=$2 AND member.removed_at IS NULL)`, [appId, agentId, job.roomId, job.commandId]);
  if (!active.rowCount) throw new Error('App connection authority ended');
  if (outcome.decision && (!['approved', 'denied', 'expired'].includes(outcome.decision.status)
      || (job.outcome?.status === 'approval' ? job.outcome.approvalId : job.outcome?.decision?.approvalId) !== outcome.decision.approvalId))
    throw new Error('Squire decision does not match this connection approval');
  if (outcome.status === 'ready') {
    const vaulted = await database.query(`SELECT 1 FROM workspace_connections connection
      JOIN agents agent ON agent.owner_id=connection.owner_identity_id
        AND COALESCE(agent.machine_id,agent.agent_id)=connection.machine_id
      WHERE agent.agent_id=$1 AND connection.service=$2 AND connection.state='active' LIMIT 1`, [agentId, job.service]);
    if (!vaulted.rowCount) throw new Error('Squire has not reported this app credential');
  }
  await database.query(`UPDATE agents SET squire_work=jsonb_set(squire_work,
    ARRAY['appConnections',$2],$3::jsonb) WHERE agent_id=$1`,
    [agentId, appId, JSON.stringify({ ...job, state: outcome.status, outcome })]);
  return job;
}
