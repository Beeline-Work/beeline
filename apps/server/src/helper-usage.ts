import { committedCommandNotificationSchema } from './postgres-live.js';
import { requireUsageSource } from './helper-usage-source.js';
import { createHash } from 'node:crypto';
import { readAgentUsage } from '@beeline/api-contract/daemon';
import { canonicalUsageAccountSnapshot, type UsageAccountPublicationResult, type UsageAccountReference, type AgentUsageCell, type UsageAccountSource } from '@beeline/api-contract/helper-usage';
import { applyAccountRead, accountRecord, agentUsageColumns, projectAgentUsage, type AgentUsageRow } from './agent-usage.js';
import type { SqlDatabase } from './database.js';
import { subscribeCommandCompletion } from './command-completion.js';

export const HELPER_USAGE_SCHEMA=`
${committedCommandNotificationSchema()}
ALTER TABLE usage_accounts ADD COLUMN IF NOT EXISTS source_revision text;
ALTER TABLE usage_accounts ADD COLUMN IF NOT EXISTS revision text;
ALTER TABLE usage_accounts ADD COLUMN IF NOT EXISTS source_at double precision;
CREATE OR REPLACE FUNCTION beeline_usage_account_identity() RETURNS trigger AS $$
BEGIN
 IF ROW(NEW.owner_id,NEW.provider,NEW.account_key) IS DISTINCT FROM ROW(OLD.owner_id,OLD.provider,OLD.account_key)
 THEN RAISE EXCEPTION 'usage_account_identity_immutable';END IF;RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_usage_account_identity ON usage_accounts;
CREATE TRIGGER beeline_usage_account_identity BEFORE UPDATE OF owner_id,provider,account_key ON usage_accounts
 FOR EACH ROW EXECUTE FUNCTION beeline_usage_account_identity();
CREATE OR REPLACE FUNCTION beeline_usage_legacy_revision() RETURNS trigger AS $$
BEGIN
 IF NEW.usage IS DISTINCT FROM OLD.usage AND NEW.source_revision IS NOT DISTINCT FROM OLD.source_revision THEN
   NEW.source_revision:=NULL;NEW.revision:=NULL;
   NEW.source_at:=GREATEST(COALESCE(OLD.source_at,0),floor(extract(epoch FROM clock_timestamp())*1000)/1000);
 END IF;RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_usage_legacy_revision ON usage_accounts;
CREATE TRIGGER beeline_usage_legacy_revision BEFORE UPDATE OF usage ON usage_accounts
 FOR EACH ROW EXECUTE FUNCTION beeline_usage_legacy_revision();
CREATE TABLE IF NOT EXISTS agent_usage_source_heads(agent_id text PRIMARY KEY,connection_id text NOT NULL,
 epoch bigint NOT NULL,revision bigint NOT NULL,digest text NOT NULL);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS usage_owner_id text;
UPDATE agents SET usage_owner_id=owner_id WHERE usage_owner_id IS NULL AND usage_snapshot IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_usage_cells(agent_id text PRIMARY KEY,owner_id text NOT NULL,
 generation text NOT NULL DEFAULT md5(random()::text||clock_timestamp()::text),revision bigint NOT NULL DEFAULT 1);
CREATE OR REPLACE FUNCTION beeline_usage_cell(agent text) RETURNS void AS $$
DECLARE owner text; previous text; scope text;
BEGIN
 SELECT owner_id INTO owner FROM agents WHERE agent_id=agent;
 SELECT owner_id INTO previous FROM agent_usage_cells WHERE agent_id=agent;
 IF owner IS NULL THEN owner:=previous;END IF;
 FOR scope IN SELECT DISTINCT value FROM unnest(ARRAY[owner,previous]) value WHERE value IS NOT NULL ORDER BY value
 LOOP PERFORM pg_advisory_xact_lock(hashtextextended('usage-cell-owner:'||scope,0));END LOOP;
 SELECT owner_id INTO previous FROM agent_usage_cells WHERE agent_id=agent FOR UPDATE;
 IF owner IS NULL THEN RETURN;END IF;
 INSERT INTO agent_usage_cells(agent_id,owner_id) VALUES(agent,owner)
 ON CONFLICT(agent_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,revision=agent_usage_cells.revision+1,
   generation=CASE WHEN agent_usage_cells.owner_id<>EXCLUDED.owner_id THEN md5(random()::text||clock_timestamp()::text) ELSE agent_usage_cells.generation END;
 PERFORM beeline_journal('usage:'||owner,jsonb_build_object('agentId',agent));
 PERFORM beeline_notify_committed_command(json_build_object('principal','usage','operation','owner','commandId',owner)::text);
 IF previous IS NOT NULL AND previous<>owner THEN
   PERFORM beeline_journal('usage:'||previous,jsonb_build_object('agentId',agent));
   PERFORM beeline_notify_committed_command(json_build_object('principal','usage','operation','owner','commandId',previous)::text);
 END IF;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION beeline_usage_snapshot_owner() RETURNS trigger AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.usage_snapshot IS DISTINCT FROM OLD.usage_snapshot THEN NEW.usage_owner_id:=NEW.owner_id;END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_usage_snapshot_owner ON agents;
CREATE TRIGGER beeline_usage_snapshot_owner BEFORE INSERT OR UPDATE OF usage_snapshot ON agents
 FOR EACH ROW EXECUTE FUNCTION beeline_usage_snapshot_owner();
CREATE OR REPLACE FUNCTION beeline_usage_cell_source() RETURNS trigger AS $$
DECLARE agent text; item jsonb;
BEGIN
 item:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='agents' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.owner_id,NEW.usage_snapshot,NEW.usage_account_id,NEW.machine_name)
      IS NOT DISTINCT FROM ROW(OLD.owner_id,OLD.usage_snapshot,OLD.usage_account_id,OLD.machine_name) THEN RETURN NULL;END IF;
   PERFORM beeline_usage_cell(item->>'agent_id');
   -- Account references own the shared-with label too. Capture both sides of
   -- attach/detach/owner moves, without treating context-only posts as changes
   -- to every sibling on the same plan.
   IF TG_OP<>'UPDATE' OR ROW(NEW.owner_id,NEW.usage_account_id)
      IS DISTINCT FROM ROW(OLD.owner_id,OLD.usage_account_id) THEN
     FOR agent IN SELECT agent_id FROM agents
       WHERE agent_id<>item->>'agent_id' AND usage_account_id IN (
         (item->>'usage_account_id')::bigint,(to_jsonb(OLD)->>'usage_account_id')::bigint)
         AND owner_id IN (item->>'owner_id',to_jsonb(OLD)->>'owner_id')
     LOOP PERFORM beeline_usage_cell(agent);END LOOP;
   END IF;
 ELSIF TG_TABLE_NAME='usage_accounts' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.usage,NEW.revision) IS NOT DISTINCT FROM ROW(OLD.usage,OLD.revision) THEN RETURN NULL;END IF;
   FOR agent IN SELECT agent_id FROM agents WHERE usage_account_id=(item->>'id')::bigint AND owner_id=item->>'owner_id'
   LOOP PERFORM beeline_usage_cell(agent);END LOOP;
 ELSE
   IF TG_OP='UPDATE' AND ROW(NEW.name,NEW.hidden_from_roster) IS NOT DISTINCT FROM ROW(OLD.name,OLD.hidden_from_roster) THEN RETURN NULL;END IF;
   FOR agent IN SELECT sibling.agent_id FROM agents sibling JOIN agents named ON named.usage_account_id=sibling.usage_account_id
     AND named.owner_id=sibling.owner_id WHERE named.agent_id=item->>'id'
   LOOP PERFORM beeline_usage_cell(agent);END LOOP;
 END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_usage_cell_source ON agents;
CREATE TRIGGER beeline_usage_cell_source AFTER INSERT OR UPDATE OF owner_id,usage_snapshot,usage_account_id,machine_name OR DELETE ON agents
 FOR EACH ROW EXECUTE FUNCTION beeline_usage_cell_source();
DROP TRIGGER IF EXISTS beeline_usage_cell_source ON usage_accounts;
CREATE TRIGGER beeline_usage_cell_source AFTER INSERT OR UPDATE OF usage,revision ON usage_accounts
 FOR EACH ROW EXECUTE FUNCTION beeline_usage_cell_source();
DROP TRIGGER IF EXISTS beeline_usage_cell_source ON identities;
CREATE TRIGGER beeline_usage_cell_source AFTER UPDATE OF name,hidden_from_roster ON identities
 FOR EACH ROW EXECUTE FUNCTION beeline_usage_cell_source();
INSERT INTO agent_usage_cells(agent_id,owner_id) SELECT agent_id,owner_id FROM agents WHERE owner_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO live_streams(id) SELECT DISTINCT 'usage:'||owner_id FROM agent_usage_cells ON CONFLICT DO NOTHING;
`;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const revisionPattern=/^[a-f0-9]{64}$/;
/** Publish one canonical source read in the authenticated agent's owner
 * partition. Account and owner locks fence late completions and reassignment. */
export async function publishUsageAccount(db:SqlDatabase,agentId:string,input:{usage:unknown;revision:unknown;ownerId:unknown;source:UsageAccountSource}):Promise<UsageAccountPublicationResult>{
  const usage=readAgentUsage(input.usage);
  if(!usage?.account||typeof input.ownerId!=='string'||!input.ownerId||input.ownerId.length>128||typeof input.revision!=='string'||!revisionPattern.test(input.revision)||
    hash(canonicalUsageAccountSnapshot(usage,input.ownerId))!==input.revision)throw new Error('Usage snapshot revision conflict');
  const account=usage.account,receivedAt=Date.now()/1000;
  return db.transaction(async tx=>{
    const agent=(await tx.query<{owner_id:string|null;usage_account_id:string|null;usage_snapshot:unknown;usage_owner_id:string|null}>(
      'SELECT owner_id,usage_account_id::text,usage_snapshot,usage_owner_id FROM agents WHERE agent_id=$1 FOR UPDATE',[agentId])).rows[0];
    if(!agent?.owner_id||agent.owner_id!==input.ownerId)throw new Error('Usage account owner changed');
    await requireUsageSource(tx,agentId,input.source);
    const ownerId=agent.owner_id;
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
      JSON.stringify(['usage-account-v1',ownerId,account.provider,account.key])]);
    const boundRevision=hash(JSON.stringify([ownerId,account.provider,account.key,input.revision]));
    const existing=(await tx.query<{id:string;usage:unknown;revision:string|null;source_revision:string|null;source_at:number|null}>(
      `SELECT id::text,usage,revision,source_revision,source_at FROM usage_accounts WHERE owner_id=$1 AND provider=$2 AND account_key=$3 FOR UPDATE`,
      [ownerId,account.provider,account.key])).rows[0];
    const sourceAt=Math.min(usage.read?.at??usage.updatedAt,receivedAt);
    let accountId:string,revision=boundRevision,superseded=false;
    if(existing){
      accountId=existing.id;
      if(existing.source_at!==null&&sourceAt<existing.source_at){
        if(!existing.revision)throw new Error('Usage snapshot superseded by a newer source');
        revision=existing.revision;superseded=true;
      }
      else if(existing.source_revision!==input.revision){
        const next=applyAccountRead(readAgentUsage(existing.usage),usage,receivedAt);
        await tx.query(`UPDATE usage_accounts SET usage=$2::jsonb,source_revision=$3,revision=$4,source_at=$5,updated_at=now() WHERE id=$1::bigint`,
          [accountId,JSON.stringify(next),input.revision,revision,sourceAt]);
      }else revision=existing.revision??boundRevision;
    }else{
      const next=applyAccountRead(undefined,usage,receivedAt);
      accountId=(await tx.query<{id:string}>(`INSERT INTO usage_accounts(owner_id,provider,account_key,usage,source_revision,revision,source_at)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING id::text`,
        [ownerId,account.provider,account.key,JSON.stringify(accountRecord(next)),input.revision,revision,sourceAt])).rows[0]!.id;
    }
    // Snapshot quota belongs only to the account. Keep this agent's actual
    // context and remove an old provider/key-spend snapshot on mode change.
    const prior=agent.usage_owner_id===ownerId?readAgentUsage(agent.usage_snapshot):undefined;
    const snapshot={updatedAt:prior?.context?prior.updatedAt:0,windows:[],...(prior?.context?{context:prior.context}:{})};
    await tx.query(`UPDATE agents SET usage_account_id=$2::bigint,usage_snapshot=$3::jsonb,updated_at=now()
      WHERE agent_id=$1 AND (usage_account_id IS DISTINCT FROM $2::bigint OR usage_snapshot IS DISTINCT FROM $3::jsonb)`,
      [agentId,accountId,JSON.stringify(snapshot)]);
    return {accountId,ownerId,revision,...(superseded?{superseded:true as const}:{})};
  });
}
export async function attachUsageAccount(db:SqlDatabase,agentId:string,input:UsageAccountReference):Promise<void>{
  if(!input.account||!revisionPattern.test(input.revision))throw new Error('Usage account reference invalid');
  await db.transaction(async tx=>{
    const agent=(await tx.query<{owner_id:string|null;usage_account_id:string|null;usage_snapshot:unknown;usage_owner_id:string|null}>(
      'SELECT owner_id,usage_account_id::text,usage_snapshot,usage_owner_id FROM agents WHERE agent_id=$1 FOR UPDATE',[agentId])).rows[0];
    if(!agent?.owner_id)throw new Error('Usage account owner required');
    await requireUsageSource(tx,agentId,input.source);
    const account=(await tx.query<{id:string}>(`SELECT id::text FROM usage_accounts WHERE owner_id=$1 AND provider=$2 AND account_key=$3 AND revision=$4 FOR SHARE`,
      [agent.owner_id,input.account.provider,input.account.key,input.revision])).rows[0];
    if(!account)throw new Error('Usage account reference authority rejected');
    const prior=agent.usage_owner_id===agent.owner_id?readAgentUsage(agent.usage_snapshot):undefined;
    const snapshot={updatedAt:prior?.context?prior.updatedAt:0,windows:[],...(prior?.context?{context:prior.context}:{})};
    await tx.query(`UPDATE agents SET usage_account_id=$2::bigint,usage_snapshot=$3::jsonb,updated_at=now()
      WHERE agent_id=$1 AND (usage_account_id IS DISTINCT FROM $2::bigint OR usage_snapshot IS DISTINCT FROM $3::jsonb)`,
      [agentId,account.id,JSON.stringify(snapshot)]);
  });
}

/** Full small DTO for the current owner. Revocation is content-free, including
 * after reassignment to another owner with the same vendor account hash. */
export async function readAgentUsageCell(db:Pick<SqlDatabase,'query'>,agentId:string,ownerId:string):Promise<AgentUsageCell>{
  const row=(await db.query<AgentUsageRow&{cell_owner:string;generation:string;revision:string;current_owner:string|null}>(
    `SELECT cell.owner_id cell_owner,cell.generation,cell.revision::text,agent.owner_id current_owner,
      ${agentUsageColumns('agent','$2',true)}
     FROM agent_usage_cells cell LEFT JOIN agents agent ON agent.agent_id=cell.agent_id
     WHERE cell.agent_id=$1`,[agentId,ownerId])).rows[0];
  if(!row)throw new Error('Usage cell unavailable');
  const revision=Number(row.revision);if(!Number.isSafeInteger(revision))throw new Error('Usage cell revision overflow');
  const identity={v:1 as const,agentId,ownerId,generation:row.generation,revision};
  if(row.cell_owner!==ownerId||row.current_owner!==ownerId)return {...identity,allowed:false};
  const cell:AgentUsageCell={...identity,allowed:true,usage:projectAgentUsage(row)??null};
  if(Buffer.byteLength(JSON.stringify(cell))>32*1024)throw new Error('Usage cell capacity');
  return cell;
}
export async function fenceAgentUsageCellEnqueue(db:SqlDatabase,ownerId:string,cell:AgentUsageCell,
  enqueue:(cell:AgentUsageCell)=>void):Promise<void>{
  await db.transaction(async tx=>{
    // The real owner row stays locked through synchronous enqueue; ownership
    // UPDATE/DELETE uses the same row without any cooperation by callers.
    await tx.query('SELECT owner_id FROM agents WHERE agent_id=$1 FOR SHARE',[cell.agentId]);
    const current=await readAgentUsageCell(tx,cell.agentId,ownerId);
    // A newer source revision can replace this already-constructed cell, but
    // an old private owner snapshot never crosses the final enqueue boundary.
    if(current.generation!==cell.generation||current.revision!==cell.revision||current.allowed!==cell.allowed)enqueue(current);
    else enqueue(cell);
  });
}
/** No held-key inventory: one owner journal interest; initial connect reads a
 * control cut only. Focus obtains its small cell through readAgentUsageCell.
 * Actual committed sources construct only their affected complete cells. */
export function subscribeAgentUsageCells(db:SqlDatabase,ownerId:string,send:(cell:AgentUsageCell)=>void,
  unavailable:()=>void,ready?:()=>void):()=>void{
  const stream='usage:'+ownerId;
  let stopped=false,running=false,dirty=true,initialized=false,position:{epoch:string;through:number}|undefined;
  const drain=async()=>{
    if(stopped||running)return;running=true;
    try{while(dirty&&!stopped){
      dirty=false;
      const prepared=await db.transaction(async tx=>{
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const head=(await tx.query<{epoch:string;sequence:string}>(`SELECT epoch,sequence::text FROM live_streams WHERE id=$1`,[stream])).rows[0];
        if(!head)return {position:undefined,cells:[] as AgentUsageCell[]};
        const through=Number(head.sequence);if(!Number.isSafeInteger(through))throw new Error('Usage stream overflow');
        if(!position&&!initialized)return {position:{epoch:head.epoch,through},cells:[] as AgentUsageCell[]};
        const from=position??{epoch:head.epoch,through:0};
        if(from.epoch!==head.epoch||from.through>through)throw new Error('Usage stream epoch changed');
        const causes=(await tx.query<{event:{agentId?:string}}>(`SELECT event FROM live_journal WHERE stream_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence`,
          [stream,from.through,through])).rows;
        if(causes.length!==through-from.through)throw new Error('Usage stream retention exceeded');
        const ids=[...new Set(causes.flatMap(row=>typeof row.event.agentId==='string'?[row.event.agentId]:[]))];
        if(ids.length>256)throw new Error('Usage source capacity');
        const cells:AgentUsageCell[]=[];for(const id of ids)cells.push(await readAgentUsageCell(tx,id,ownerId));
        return {position:{epoch:head.epoch,through},cells};
      });
      for(const cell of prepared.cells)if(!stopped)await fenceAgentUsageCellEnqueue(db,ownerId,cell,current=>{if(!stopped)send(current);});
      const first=!initialized;position=prepared.position;initialized=true;if(first)ready?.();
    }}catch{if(!stopped){stopped=true;release();unavailable();}}
    finally{running=false;}
  };
  const release=subscribeCommandCompletion({principal:'usage',operation:'owner',commandId:ownerId},()=>{dirty=true;void drain();});
  void drain();return()=>{stopped=true;release();};
}
