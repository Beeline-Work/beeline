import { requireUsageSource } from './helper-usage-source.js';
import { createHash } from 'node:crypto';
import { readAgentUsage } from '@beeline/api-contract/daemon';
import { canonicalUsageAccountSnapshot, type UsageAccountPublicationResult, type UsageAccountReference, type UsageAccountSource } from '@beeline/api-contract/helper-usage';
import { applyAccountRead, accountRecord } from './agent-usage.js';
import type { SqlDatabase } from './database.js';

export { networkRouterEnabled as helperUsageEnabled } from './network-router-rollout.js';
export const HELPER_USAGE_SCHEMA=`
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
CREATE OR REPLACE FUNCTION beeline_usage_snapshot_owner() RETURNS trigger AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.usage_snapshot IS DISTINCT FROM OLD.usage_snapshot THEN NEW.usage_owner_id:=NEW.owner_id;END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_usage_snapshot_owner ON agents;
CREATE TRIGGER beeline_usage_snapshot_owner BEFORE INSERT OR UPDATE OF usage_snapshot ON agents
 FOR EACH ROW EXECUTE FUNCTION beeline_usage_snapshot_owner();
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
