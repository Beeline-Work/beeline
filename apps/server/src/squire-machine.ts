import { SQUIRE_MCP_TARGET } from '@beeline/api-contract/phone';
import { failConnectingOffers } from './connector-offer-completion.js';
import type { ConnectorAssignment, ConnectorStatus, PostConnectorStatusInput } from '@beeline/api-contract/daemon';
import type { SquireMachineReport } from '@beeline/api-contract/workbench';
import { appKeyForHost, registrableDomain } from '@beeline/api-contract/app-connections';
import type { SqlDatabase } from './database.js';
import { CommandRefusalError } from './command-refusal.js';
import { notifyConnectorAssignment, notifyAgentConfigChanges } from './postgres-live.js';

/** A routing address for machine work, not a persisted connector identity. */
export const squireMachineAddress = (machineId: string): string => `squire:${machineId}`;
export const squireMachineId = (address: string): string | undefined =>
  address.startsWith('squire:') ? address.slice(7) : undefined;

export type SquireMachineWork = {
  reportedAt?: number;
  install?: boolean;
  disconnected?: boolean;
  signedInAs?: string;
  forceReloginProvider?: string;
  steps?: ConnectorStatus['steps'];
  signIn?: ConnectorStatus['signIn'] | null;
  errorMessage?: string;
};
type AgentWork = { ops?: string[]; signedInApps?: Record<string,{domain:string;checkedAt:number}> };
export interface SquireMachineState {
  owner_id: string;
  machine_id: string;
  generation: number;
  revision: string;
  helper_agent_id: string | null;
  squire_work: SquireMachineWork;
  squire_report: SquireMachineReport | null;
}
export const SQUIRE_MACHINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS squire_machines (
 owner_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
 machine_id text NOT NULL,
 generation integer NOT NULL DEFAULT 0,
 revision bigint NOT NULL DEFAULT 0,
 helper_agent_id text REFERENCES identities(id) ON DELETE SET NULL,
 squire_work jsonb NOT NULL DEFAULT '{}'::jsonb,
 squire_report jsonb,
 PRIMARY KEY(owner_id,machine_id)
);
CREATE INDEX IF NOT EXISTS squire_machines_helper ON squire_machines(helper_agent_id);
`;

/** Move existing installation intent and broker facts once; helper inboxes
 * retain only their own pending operations and session sign-in observations. */
export async function backfillSquireMachines(database: SqlDatabase): Promise<void> {
  await database.query(`WITH helpers AS (
    SELECT agent_id,owner_id,COALESCE(machine_id,agent_id) machine_id,squire_work,updated_at FROM agents
  ) INSERT INTO squire_machines(owner_id,machine_id,generation,helper_agent_id,squire_work)
    SELECT owner_id,machine_id,COALESCE(max((squire_work->>'generation')::int),0),
      CASE WHEN bool_or(squire_work->>'disconnected'='true') THEN NULL ELSE
        (array_agg(agent_id ORDER BY COALESCE((squire_work->>'generation')::int,0) DESC,
          (squire_work->>'install'='true') DESC NULLS LAST,updated_at DESC,agent_id))[1] END,
      CASE WHEN bool_or(squire_work->>'disconnected'='true') THEN '{"disconnected":true}'::jsonb ELSE
        (array_agg(squire_work-ARRAY['generation','ops','signedInApps'] ORDER BY
          COALESCE((squire_work->>'generation')::int,0) DESC,
          (squire_work->>'install'='true') DESC NULLS LAST,updated_at DESC,agent_id))[1] END
    FROM helpers WHERE owner_id IS NOT NULL
      AND squire_work ?| ARRAY['generation','install','disconnected','errorMessage']
    GROUP BY owner_id,machine_id ON CONFLICT(owner_id,machine_id) DO NOTHING`);
  await database.query(`UPDATE agents SET squire_work=squire_work-ARRAY['generation','reportedAt','install','disconnected',
    'signedInAs','forceReloginProvider','steps','signIn','errorMessage']
    WHERE squire_work ?| ARRAY['generation','reportedAt','install','disconnected','signedInAs','forceReloginProvider','steps','signIn','errorMessage']`);
}

/** The INSERT establishes a real installation source, never overwriting an
 * owner's prior unpair. A separate read sees a competing creator's commit. */
export async function ensureSquireMachine(database: SqlDatabase, ownerId: string, machineId: string): Promise<SquireMachineState> {
  const existing=(await database.query<SquireMachineState>('SELECT owner_id,machine_id,generation,revision,helper_agent_id,squire_work,squire_report FROM squire_machines WHERE owner_id=$1 AND machine_id=$2',[ownerId,machineId])).rows[0];
  if(existing) return existing;
  await database.query(`INSERT INTO squire_machines(owner_id,machine_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[ownerId,machineId]);
  return (await database.query<SquireMachineState>('SELECT owner_id,machine_id,generation,revision,helper_agent_id,squire_work,squire_report FROM squire_machines WHERE owner_id=$1 AND machine_id=$2',[ownerId,machineId])).rows[0]!;
}

export async function machineSquireReport(database: SqlDatabase, ownerId: string, machineId?: string): Promise<SquireMachineReport | undefined> {
  return (await database.query<{squire_report:SquireMachineReport}>(`SELECT squire_report FROM squire_machines
    WHERE owner_id=$1 AND squire_report IS NOT NULL AND ($2::text IS NULL OR machine_id=$2)
    ORDER BY (squire_report->>'reportedAt')::double precision DESC LIMIT 1`,[ownerId,machineId??null])).rows[0]?.squire_report;
}

/** Setup consent survives a lost MCP session. Explicit owner unpair wins;
 * legacy accepted installs cover machines predating the canonical state row. */
export async function squireSetupApproved(database: SqlDatabase, agentId: string, workspaceId: string): Promise<boolean> {
  const row = (await database.query<{ approved: boolean }>(`SELECT
    COALESCE(source.squire_work->>'disconnected','false')<>'true' AND (
      EXISTS (SELECT 1 FROM agent_grants grant_row WHERE grant_row.agent_id=agent.agent_id
        AND grant_row.workspace_id=$2 AND grant_row.kind='mcp' AND grant_row.target=$3
        AND grant_row.status='approved' AND grant_row.decided_by=agent.owner_id
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now()))
      OR (source.generation>0 AND source.helper_agent_id IS NOT NULL)
      OR (source.owner_id IS NULL AND EXISTS (SELECT 1 FROM connector_offers offer
        WHERE offer.addressee_id=agent.owner_id AND offer.accepted_by=agent.owner_id
          AND offer.machine_id=COALESCE(agent.machine_id,agent.agent_id)
          AND offer.connector_type='trusty-squire' AND offer.status='accepted'))
    ) approved FROM agents agent LEFT JOIN squire_machines source
      ON source.owner_id=agent.owner_id AND source.machine_id=COALESCE(agent.machine_id,agent.agent_id)
    WHERE agent.agent_id=$1`, [agentId, workspaceId, SQUIRE_MCP_TARGET])).rows[0];
  return row?.approved === true;
}

export async function queueSquireWork(database: SqlDatabase, agentId: string,
  input: { install?: boolean; forceReloginProvider?: string; op?: string }): Promise<number> {
  const agent=(await database.query<{owner_id:string;machine_id:string}>(
    'SELECT owner_id,COALESCE(machine_id,agent_id) machine_id FROM agents WHERE agent_id=$1',[agentId])).rows[0];
  if(!agent) throw new Error('machine helper not found');
  const source=await ensureSquireMachine(database,agent.owner_id,agent.machine_id);
  if(input.install){
    const work:SquireMachineWork={install:true,reportedAt:Date.now()/1000,
      steps:[{label:'Install on helper',status:'pending'},{label:'Connect provider account',status:'pending'}],
      ...(input.forceReloginProvider?{forceReloginProvider:input.forceReloginProvider}:{})};
    const result=await database.query<{generation:number}>(`UPDATE squire_machines SET generation=generation+1,
      revision=revision+1,helper_agent_id=$4,squire_work=$5::jsonb ||
        CASE WHEN squire_work ? 'signedInAs' THEN jsonb_build_object('signedInAs',squire_work->'signedInAs') ELSE '{}'::jsonb END
      WHERE owner_id=$1 AND machine_id=$2 AND generation=$3
      RETURNING generation`,[agent.owner_id,agent.machine_id,source.generation,agentId,JSON.stringify(work)]);
    if(!result.rowCount) throw new CommandRefusalError('Squire installation changed; no install was queued',409);
    await notifyConnectorAssignment(database,agentId);
    return result.rows[0]!.generation;
  }
  if(input.op) await database.query(`UPDATE agents SET squire_work=jsonb_set(squire_work,'{ops}',
    COALESCE(squire_work->'ops','[]'::jsonb)||CASE WHEN COALESCE(squire_work->'ops','[]'::jsonb) ? $2::text
      THEN '[]'::jsonb ELSE jsonb_build_array($2::text) END)
    WHERE agent_id=$1`,[agentId,input.op]);
  await notifyConnectorAssignment(database,agentId);
  return source.generation;
}

/** Owner intent, cached keys and standing grants change only for the winner. */
export async function unpairSquireMachine(database: SqlDatabase,ownerId: string,machineId: string): Promise<void> {
  await database.transaction(async db=>{
    const source=await ensureSquireMachine(db,ownerId,machineId);
    const accepted=await db.query(`UPDATE squire_machines SET generation=generation+1,revision=revision+1,helper_agent_id=NULL,
      squire_work='{"disconnected":true}'::jsonb,
      squire_report=jsonb_build_object('status','not-added','reportedAt',extract(epoch FROM clock_timestamp()))
      WHERE owner_id=$1 AND machine_id=$2 AND generation=$3 RETURNING owner_id`,[ownerId,machineId,source.generation]);
    if(!accepted.rowCount) throw new CommandRefusalError('Squire installation changed; no unpair was applied',409);
    // A report can have committed while the generation CAS waited. This new
    // statement must see its keys; a sibling CTE would retain the old snapshot.
    const result=(await db.query<{agent_ids:string[]}>(`WITH removed AS (
      DELETE FROM workspace_connections WHERE owner_identity_id=$1 AND machine_id=$2
    ), cleared AS (
      UPDATE agents SET squire_work='{}'::jsonb WHERE owner_id=$1 AND COALESCE(machine_id,agent_id)=$2 RETURNING agent_id
    ), revoked AS (
      UPDATE agent_grants SET status='revoked' WHERE kind='mcp' AND target=$3 AND status IN ('approved','once')
        AND agent_id IN (SELECT agent_id FROM cleared)
    ) SELECT ARRAY(SELECT agent_id FROM cleared) agent_ids`,[ownerId,machineId,SQUIRE_MCP_TARGET])).rows[0]!;
    await notifyAgentConfigChanges(db,result.agent_ids);
  });
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
  const row=(await database.query<{machine_id:string;squire_work:AgentWork;helper_agent_id:string|null;generation:number;work:SquireMachineWork}>(
    `SELECT COALESCE(agent.machine_id,agent.agent_id) machine_id,agent.squire_work,source.helper_agent_id,
      source.generation,source.squire_work work FROM agents agent LEFT JOIN squire_machines source
        ON source.owner_id=agent.owner_id AND source.machine_id=COALESCE(agent.machine_id,agent.agent_id)
      WHERE agent.agent_id=$1`,[agentId])).rows[0];
  if(!row) return [];
  const connectorId=squireMachineAddress(row.machine_id),assignments:ConnectorAssignment[]=[];
  if(row.helper_agent_id===agentId&&row.work.install) assignments.push({kind:'install',connectorId,connectorType:'trusty-squire',
    pairingGeneration:row.generation,...(row.work.forceReloginProvider?{forceReloginProvider:row.work.forceReloginProvider}:{})});
  for(const op of row.squire_work.ops??[]) {
    if(op==='sync') assignments.push({kind:'sync',connectorId,connectorType:'trusty-squire'});
    else if(op.startsWith('revoke-grants:')) assignments.push({kind:'revoke-grants',connectorId,connectorType:'trusty-squire',reference:op.slice(14)});
  }
  if(row.squire_work.ops?.includes('sync')){
    const claimed=await database.query(`UPDATE agents SET squire_work=jsonb_set(squire_work,'{ops}',$2::jsonb)
      WHERE agent_id=$1 AND squire_work=$3::jsonb RETURNING agent_id`,
    [agentId,JSON.stringify(row.squire_work.ops.filter(op=>op!=='sync')),JSON.stringify(row.squire_work)]);
    if(!claimed.rowCount) return [];
  }
  return assignments;
}

export async function squireWorkStatus(database: SqlDatabase, agentId: string): Promise<ConnectorStatus> {
  const row=(await database.query<{machine_id:string;machine_name:string|null;squire_work:SquireMachineWork|null;squire_report:SquireMachineReport|null}>(
    `SELECT COALESCE(a.machine_id,a.agent_id) machine_id,
      COALESCE(a.machine_name,(SELECT MAX(sibling.machine_name) FROM agents sibling WHERE sibling.owner_id=a.owner_id
        AND COALESCE(sibling.machine_id,sibling.agent_id)=COALESCE(a.machine_id,a.agent_id))) machine_name,
      source.squire_work,source.squire_report FROM agents a LEFT JOIN squire_machines source
        ON source.owner_id=a.owner_id AND source.machine_id=COALESCE(a.machine_id,a.agent_id) WHERE a.agent_id=$1`,[agentId])).rows[0];
  if(!row) throw new Error('machine helper not found');
  const work=row.squire_work??{},report=row.squire_report;
  const status=work.errorMessage?'error':work.install?'installing':report?.status==='connected'?'connected':report?.status==='error'?'error':'disconnected';
  const errorMessage=status==='error'?work.errorMessage??report?.errorMessage:undefined;
  const steps=work.install||work.errorMessage?work.steps??[]:[];
  return {connectorId:squireMachineAddress(row.machine_id),status,
    steps:errorMessage&&!steps.some(step=>step.status==='failed')?[...steps,{label:'waiting for sign-in',status:'failed',reason:errorMessage}]:steps,
    ...(row.machine_name?{helperName:row.machine_name}:{}),...(work.install&&work.signIn?{signIn:work.signIn}:{}),
    ...(errorMessage?{errorMessage}:{})};
}

export async function reportSquireWork(database: SqlDatabase, agentId: string,
  input: Pick<PostConnectorStatusInput,'connectorId'|'pairingGeneration'|'steps'|'signIn'|'errorMessage'> & {signedInAs?:string},complete=false) {
  const patch:SquireMachineWork={reportedAt:Date.now()/1000,steps:input.steps??[],
    ...(input.signedInAs?{signedInAs:input.signedInAs}:{}),...(input.signIn!==undefined?{signIn:input.signIn}:{}),
    ...(input.errorMessage?{errorMessage:input.errorMessage}:{})};
  const remove=complete?['install','signIn','steps','errorMessage','forceReloginProvider',...(!input.signedInAs?['signedInAs']:[])]:
    input.errorMessage?['install','signIn']:[];
  const changed=await database.query(`UPDATE squire_machines source SET squire_work=(source.squire_work || $4::jsonb)-$5::text[]
    FROM agents agent WHERE agent.agent_id=$1 AND source.owner_id=agent.owner_id
      AND source.machine_id=COALESCE(agent.machine_id,agent.agent_id) AND source.helper_agent_id=$1
      AND source.generation=$2 AND source.squire_work->>'install'='true' AND 'squire:'||source.machine_id=$3 RETURNING source.generation`,
  [agentId,input.pairingGeneration??1,input.connectorId,JSON.stringify(patch),remove]);
  if(!changed.rowCount) throw new Error('Squire work not found for this helper');
  if(input.errorMessage) await failConnectingOffers(database,{agentId});
}

/** Whether this agent's Squire session was last seen signed in to the app. */
export async function squireSignedIn(database: SqlDatabase, agentId: string, appKey: string): Promise<boolean> {
  const row = (await database.query<{ squire_work: AgentWork }>(
    'SELECT squire_work FROM agents WHERE agent_id=$1', [agentId])).rows[0];
  return Boolean(row?.squire_work.signedInApps?.[appKey]);
}

/** Record that this agent's Squire session reached the app's own site signed in. */
export async function recordSquireSignIn(database: SqlDatabase, agentId: string,
  appKey: string, domain: string): Promise<void> {
  await database.query(`UPDATE agents SET squire_work=jsonb_set(squire_work,'{signedInApps}',
      COALESCE(squire_work->'signedInApps','{}'::jsonb)
        || jsonb_build_object($2::text,jsonb_build_object('domain',$3::text,'checkedAt',$4::bigint)))
    WHERE agent_id=$1`, [agentId, appKey, domain, Date.now()]);
}

/** Drop the recorded sign-in for one app, or for every app on a URL's site. */
export async function forgetSquireSignIn(database: SqlDatabase, agentId: string,
  target: { appKey: string } | { url: string }): Promise<void> {
  let host = '';
  if ('url' in target) try { host = new URL(target.url).hostname; } catch { return; }
  const domain = host ? registrableDomain(host) : undefined;
  const key = 'appKey' in target ? target.appKey : appKeyForHost(host);
  await database.query(`UPDATE agents agent SET squire_work=jsonb_set(squire_work,'{signedInApps}',
    COALESCE((SELECT jsonb_object_agg(app.key,app.value) FROM jsonb_each(agent.squire_work->'signedInApps') app
      WHERE app.key IS DISTINCT FROM $2::text AND ($3::text IS NULL OR app.value->>'domain' IS DISTINCT FROM $3)), '{}'::jsonb))
    WHERE agent_id=$1 AND squire_work ? 'signedInApps'`, [agentId,key??null,domain??null]);
}
