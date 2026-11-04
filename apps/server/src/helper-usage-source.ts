import { createHash } from 'node:crypto';
import type { AgentUsage } from '@beeline/api-contract/daemon';
import { canonicalUsagePayload, type UsageAccountSource, type UsageWriteSource } from '@beeline/api-contract/helper-usage';
import type { SqlDatabase } from './database.js';
export async function requireUsageSource(db:SqlDatabase,agentId:string,source:UsageAccountSource):Promise<void>{
  if(!source||typeof source.connectionId!=='string'||!source.connectionId||source.connectionId.length>128||
    !Number.isSafeInteger(source.epoch)||source.epoch<1)throw new Error('Usage source invalid');
  if(!(await db.query(`SELECT 1 FROM agent_connections WHERE agent_id=$1 AND connection_id=$2 AND epoch=$3
    AND released_at IS NULL FOR SHARE`,[agentId,source.connectionId,source.epoch])).rowCount)throw new Error('Usage source ownership changed');
}
/** The calling transaction already locks the real agent owner row. Source
 * counter and effect commit together; delayed responses cannot rewind context. */
export async function acceptUsageWriteSource(db:SqlDatabase,agentId:string,ownerId:string|null,
  usage:AgentUsage,scope:UsageWriteSource):Promise<boolean>{
  if(scope.v!==1||scope.ownerId!==ownerId||!Number.isSafeInteger(scope.revision)||scope.revision<1)
    throw new Error('Usage source authority rejected');
  await requireUsageSource(db,agentId,scope.source);
  const digest=createHash('sha256').update(canonicalUsagePayload(usage)).digest('hex');
  const previous=(await db.query<{connection_id:string;epoch:string;revision:string;digest:string}>(
    'SELECT connection_id,epoch::text,revision::text,digest FROM agent_usage_source_heads WHERE agent_id=$1 FOR UPDATE',[agentId])).rows[0];
  if(previous?.connection_id===scope.source.connectionId&&Number(previous.epoch)===scope.source.epoch){
    if(Number(previous.revision)>scope.revision)return false;
    if(Number(previous.revision)===scope.revision){if(previous.digest!==digest)throw new Error('Usage source revision conflict');return false;}
  }
  await db.query(`INSERT INTO agent_usage_source_heads(agent_id,connection_id,epoch,revision,digest) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(agent_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,epoch=EXCLUDED.epoch,revision=EXCLUDED.revision,digest=EXCLUDED.digest`,
    [agentId,scope.source.connectionId,scope.source.epoch,scope.revision,digest]);
  return true;
}
