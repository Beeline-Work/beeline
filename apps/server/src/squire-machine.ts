import type { AppConnectionJob, ConnectorAssignment, ConnectorStatus, PostConnectorStatusInput } from '@beeline/api-contract/daemon';
import type { SquireMachineReport } from '@beeline/api-contract/workbench';
import type { SqlDatabase } from './database.js';
import { notifyConnectorAssignment } from './postgres-live.js';

/** A routing address for machine work, not a persisted connector identity. */
export const squireMachineAddress = (machineId: string): string => `squire:${machineId}`;
export const squireMachineId = (address: string): string | undefined =>
  address.startsWith('squire:') ? address.slice(7) : undefined;

type Work = {
  generation: number;
  install?: boolean;
  disconnected?: boolean;
  forceReloginProvider?: string;
  steps?: ConnectorStatus['steps'];
  signIn?: ConnectorStatus['signIn'] | null;
  errorMessage?: string;
  ops?: string[];
  appConnections?: Record<string, AppConnectionJob>;
};

export async function machineSquireReport(database: SqlDatabase, ownerId: string, machineId?: string):
  Promise<SquireMachineReport | undefined> {
  return (await database.query<{ squire_report: SquireMachineReport }>(
    `SELECT squire_report FROM agents WHERE owner_id=$1 AND squire_report IS NOT NULL
       AND ($2::text IS NULL OR COALESCE(machine_id,agent_id)=$2)
     ORDER BY (squire_report->>'reportedAt')::double precision DESC LIMIT 1`,
    [ownerId, machineId ?? null],
  )).rows[0]?.squire_report;
}

export async function queueSquireWork(database: SqlDatabase, agentId: string,
  input: { install?: boolean; forceReloginProvider?: string; op?: string }): Promise<number> {
  const machine = (await database.query<{ owner_id: string; machine_id: string }>(
    'SELECT owner_id,COALESCE(machine_id,agent_id) machine_id FROM agents WHERE agent_id=$1', [agentId],
  )).rows[0];
  if (!machine) throw new Error('machine helper not found');
  await database.query('SELECT pg_advisory_xact_lock(hashtext($1))',
    [`squire-work:${machine.owner_id}:${machine.machine_id}`]);
  const row = (await database.query<{ squire_work: Work }>(
    `SELECT squire_work FROM agents WHERE agent_id=$1 FOR UPDATE`, [agentId],
  )).rows[0];
  if (!row) throw new Error('machine helper not found');
  const previous = row.squire_work;
  let generation = previous.generation ?? 0;
  if (input.install) {
    generation = Number((await database.query<{ generation: number }>(
      `SELECT COALESCE(MAX((squire_work->>'generation')::int),0) generation FROM agents
       WHERE owner_id=$1 AND COALESCE(machine_id,agent_id)=$2`,
      [machine.owner_id, machine.machine_id],
    )).rows[0]!.generation) + 1;
    await database.query(`UPDATE agents SET squire_work=squire_work
      - 'disconnected' - 'install' - 'steps' - 'signIn' - 'errorMessage' - 'forceReloginProvider'
      WHERE owner_id=$1 AND COALESCE(machine_id,agent_id)=$2 AND agent_id<>$3`,
      [machine.owner_id, machine.machine_id, agentId]);
  }
  const work: Work = input.install
    ? { generation, install: true,
        steps: [{ label: 'Install on helper', status: 'pending' },
          { label: 'Connect provider account', status: 'pending' }],
        ...(input.forceReloginProvider ? { forceReloginProvider: input.forceReloginProvider } : {}),
        ops: previous.ops ?? [], appConnections: previous.appConnections }
    : { ...previous, generation: previous.generation ?? 0,
        ops: [...new Set([...(previous.ops ?? []), ...(input.op ? [input.op] : [])])] };
  await database.query('UPDATE agents SET squire_work=$2::jsonb WHERE agent_id=$1',
    [agentId, JSON.stringify(work)]);
  await notifyConnectorAssignment(database, agentId);
  return work.generation;
}

export async function queueOwnerSquireWork(database: SqlDatabase, ownerId: string, machineId: string, op: string) {
  const agent = (await database.query<{ agent_id: string }>(
    `SELECT a.agent_id FROM agents a
     JOIN identities identity ON identity.id=a.agent_id AND NOT identity.hidden_from_roster
     WHERE a.owner_id=$1 AND COALESCE(a.machine_id,a.agent_id)=$2
       AND EXISTS (SELECT 1 FROM memberships m WHERE m.identity_id=a.agent_id
         AND m.room_id IS NULL AND m.removed_at IS NULL)
     ORDER BY (SELECT MAX(p.updated_at) FROM live_outputs p WHERE p.agent_id=a.agent_id
       AND p.kind='presence' AND p.body->>'status'='online'
       AND (p.updated_at>now()-interval '90 seconds' OR p.body->>'held'='true')) DESC NULLS LAST,
       a.updated_at DESC,a.agent_id LIMIT 1`, [ownerId, machineId],
  )).rows[0];
  if (agent) await queueSquireWork(database, agent.agent_id, { op });
  if (op === 'sync') await database.query(
    'UPDATE workspace_connections SET last_synced_at=NULL WHERE owner_identity_id=$1 AND machine_id=$2',
    [ownerId, machineId]);
}

export async function squireAssignments(database: SqlDatabase, agentId: string): Promise<ConnectorAssignment[]> {
  const row = (await database.query<{ machine_id: string; squire_work: Work }>(
    `SELECT COALESCE(machine_id,agent_id) machine_id,squire_work FROM agents WHERE agent_id=$1 FOR UPDATE`,
    [agentId],
  )).rows[0];
  if (!row) return [];
  const work = row.squire_work;
  const connectorId = squireMachineAddress(row.machine_id);
  const assignments: ConnectorAssignment[] = [];
  for (const job of Object.values(work.appConnections ?? {})) {
    if (job.state === 'queued' && !work.install) {
      const active = await database.query(`SELECT 1 FROM workspace_apps app
        JOIN rooms room ON room.id=$2 AND room.archived_at IS NULL
        JOIN agent_commands command ON command.id=$3 AND command.room_id=$2
          AND command.agent_id=$4 AND command.state<>'cancelled'
        JOIN agents agent ON agent.agent_id=$4 AND agent.owner_id=app.owner_identity_id
        WHERE app.id=$1::uuid AND app.state='active'
          AND EXISTS (SELECT 1 FROM memberships member WHERE member.room_id=$2
            AND member.identity_id=$4 AND member.removed_at IS NULL)`, [job.appId, job.roomId, job.commandId, agentId]);
      if (!active.rowCount) continue;
      assignments.push({ kind: 'connect-app', connectorId: `app:${job.appId}`, job });
      await database.query(`UPDATE agents SET squire_work=jsonb_set(squire_work,
        ARRAY['appConnections',$2,'state'],'"running"'::jsonb) WHERE agent_id=$1`, [agentId, job.appId]);
    }
  }
  if (work.install) assignments.push({ kind: 'install', connectorId, connectorType: 'trusty-squire',
    pairingGeneration: work.generation,
    ...(work.forceReloginProvider ? { forceReloginProvider: work.forceReloginProvider } : {}) });
  for (const op of work.ops ?? []) {
    if (op === 'sync') assignments.push({ kind: 'sync', connectorId, connectorType: 'trusty-squire' });
    else if (op.startsWith('revoke-grants:')) assignments.push({ kind: 'revoke-grants', connectorId,
      connectorType: 'trusty-squire', reference: op.slice(14) });
  }
  if (work.ops?.includes('sync'))
    await database.query(`UPDATE agents SET squire_work=jsonb_set(squire_work,'{ops}',$2::jsonb)
      WHERE agent_id=$1`, [agentId, JSON.stringify(work.ops.filter((op) => op !== 'sync'))]);
  return assignments;
}

export async function squireWorkStatus(database: SqlDatabase, agentId: string): Promise<ConnectorStatus> {
  const row = (await database.query<{ machine_id: string; machine_name: string | null;
    squire_work: Work; owner_id: string }>(
    `SELECT COALESCE(a.machine_id,a.agent_id) machine_id,
      COALESCE(a.machine_name,(SELECT MAX(sibling.machine_name) FROM agents sibling
        WHERE sibling.owner_id=a.owner_id
          AND COALESCE(sibling.machine_id,sibling.agent_id)=COALESCE(a.machine_id,a.agent_id))) machine_name,
      a.squire_work,a.owner_id FROM agents a WHERE a.agent_id=$1`, [agentId],
  )).rows[0];
  if (!row) throw new Error('machine helper not found');
  const report = await machineSquireReport(database, row.owner_id, row.machine_id);
  const work = row.squire_work;
  return { connectorId: squireMachineAddress(row.machine_id),
    status: work.errorMessage ? 'error' : work.install ? 'installing'
      : report?.status === 'connected' ? 'connected' : report?.status === 'error' ? 'error' : 'disconnected',
    steps: work.install ? work.steps ?? [] : [],
    ...(row.machine_name ? { helperName: row.machine_name } : {}),
    ...(work.install && work.signIn ? { signIn: work.signIn } : {}),
    ...(work.errorMessage || report?.errorMessage
      ? { errorMessage: work.errorMessage ?? report?.errorMessage } : {}) };
}

export async function reportSquireWork(database: SqlDatabase, agentId: string,
  input: Pick<PostConnectorStatusInput, 'connectorId' | 'pairingGeneration' | 'steps' | 'signIn' | 'errorMessage'>,
  complete = false) {
  const row = (await database.query<{ machine_id: string; squire_work: Work }>(
    `SELECT COALESCE(machine_id,agent_id) machine_id,squire_work FROM agents WHERE agent_id=$1 FOR UPDATE`,
    [agentId],
  )).rows[0];
  if (!row || squireMachineAddress(row.machine_id) !== input.connectorId ||
      !row.squire_work.install || row.squire_work.generation !== (input.pairingGeneration ?? 1))
    throw new Error('Squire work not found for this helper');
  const work: Work = { ...row.squire_work, steps: input.steps,
    ...(input.signIn !== undefined ? { signIn: input.signIn } : {}),
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}) };
  if (complete) {
    delete work.install; delete work.signIn; delete work.steps;
    delete work.errorMessage; delete work.forceReloginProvider;
  }
  await database.query('UPDATE agents SET squire_work=$2::jsonb WHERE agent_id=$1',
    [agentId, JSON.stringify(work)]);
}
