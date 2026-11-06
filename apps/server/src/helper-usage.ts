import { requireUsageSource } from './helper-usage-source.js';
import { createHash } from 'node:crypto';
import { readAgentUsage } from '@beeline/api-contract/daemon';
import { canonicalUsageAccountSnapshot, type UsageAccountPublicationResult, type UsageAccountReference, type UsageAccountSource } from '@beeline/api-contract/helper-usage';
import {USAGE_ACCOUNT_READ_SCHEMA} from './usage-account-read.js';
import type { SqlDatabase } from './database.js';

export { networkRouterEnabled as helperUsageEnabled } from './network-router-rollout.js';
export const HELPER_USAGE_SCHEMA=`
${USAGE_ACCOUNT_READ_SCHEMA}
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
 * partition. The native account upsert fences late completions; the agent row fences reassignment. */
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
    const boundRevision=hash(JSON.stringify([ownerId,account.provider,account.key,input.revision]));
    const sourceAt=Math.min(usage.read?.at??usage.updatedAt,receivedAt);
    const published=(await tx.query<{id:string;revision:string|null;source_at:number}>(`
      INSERT INTO usage_accounts(owner_id,provider,account_key,usage,source_revision,revision,source_at)
      VALUES($1,$2,$3,beeline_account_read(NULL,$4::jsonb,$8),$5,$6,$7)
      ON CONFLICT(owner_id,provider,account_key) DO UPDATE SET
        (usage,source_revision,revision,source_at,updated_at)=(SELECT
          CASE WHEN newer THEN beeline_account_read(usage_accounts.usage,$4::jsonb,$8) ELSE usage_accounts.usage END,
          CASE WHEN newer THEN excluded.source_revision ELSE usage_accounts.source_revision END,
          CASE WHEN newer THEN excluded.revision ELSE usage_accounts.revision END,
          CASE WHEN newer THEN excluded.source_at ELSE usage_accounts.source_at END,
          CASE WHEN newer THEN now() ELSE usage_accounts.updated_at END
          FROM (SELECT (usage_accounts.source_at IS NULL OR usage_accounts.source_at<=excluded.source_at)
            AND usage_accounts.source_revision IS DISTINCT FROM excluded.source_revision newer) publication)
      RETURNING id::text,revision,source_at`,[ownerId,account.provider,account.key,JSON.stringify(usage),
        input.revision,boundRevision,sourceAt,receivedAt])).rows[0]!;
    const accountId=published.id,superseded=sourceAt<Number(published.source_at);
    if(superseded&&!published.revision) throw new Error('Usage snapshot superseded by a newer source');
    const revision=published.revision??boundRevision;
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
