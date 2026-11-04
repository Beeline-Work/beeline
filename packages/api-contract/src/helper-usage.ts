import { readAgentUsage, type AgentUsage } from './agent-usage.js';
const canonicalUsageValue=(value:unknown):string=>{
    if(Array.isArray(value))return '['+value.map(canonicalUsageValue).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,item])=>item!==undefined)
      .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonicalUsageValue(item)).join(',')+'}';
    return JSON.stringify(value);
  };

export const canonicalUsagePayload=(usage:AgentUsage):string=>canonicalUsageValue(usage);
/** Snapshot identity excludes per-agent context/spend and local presentation. */
export function canonicalUsageAccountSnapshot(usage:AgentUsage,ownerId?:string):string {
  if(!usage.account||usage.spend||usage.free)throw new Error('Account usage snapshot required');
  // Both the provider adapter and server hash the validated wire value. Text
  // normalization must happen before identity, including discarded long names.
  const normalized=readAgentUsage(usage);
  if(!normalized?.account)throw new Error('Account usage snapshot required');
  const snapshot={...(ownerId?{ownerId}:{}),updatedAt:normalized.updatedAt,windows:normalized.windows,account:normalized.account,
    ...(normalized.plan?{plan:normalized.plan}:{}),...(normalized.credits?{credits:normalized.credits}:{}),...(normalized.read?{read:normalized.read}:{})};
  return canonicalUsageValue(snapshot);
}
export interface UsageAccountPublicationResult {
  readonly accountId:string;
  /** Server-derived owner partition; a sibling cannot attach across owners. */
  readonly ownerId:string;
  readonly revision:string;
  readonly superseded?:true;
}
export interface UsageAccountSource {readonly connectionId:string;readonly epoch:number}
export interface UsageWriteSource {readonly v:1;readonly ownerId:string;readonly source:UsageAccountSource;readonly revision:number}
export interface UsageAccountReference {
  readonly source:UsageAccountSource;
  readonly account:{readonly provider:string;readonly key:string};
  readonly revision:string;
}

/** Complete canonical usage cell. It owns only the existing usage display;
 * profile/catalog DTOs remain independent server-owned values. */
export type AgentUsageCell = {
  readonly v:1;
  readonly agentId:string;
  readonly ownerId:string;
  readonly generation:string;
  readonly revision:number;
} & ({readonly allowed:true;readonly usage:AgentUsage|null}|{readonly allowed:false;readonly usage?:never});

export function readAgentUsageCellValue(value:unknown):AgentUsageCell|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const item=value as Record<string,unknown>;
  if(item.v!==1||typeof item.agentId!=='string'||!item.agentId||item.agentId.length>128||
    typeof item.ownerId!=='string'||!item.ownerId||item.ownerId.length>128||
    typeof item.generation!=='string'||!/^[a-f0-9]{32}$/.test(item.generation)||
    !Number.isSafeInteger(item.revision)||Number(item.revision)<1)return;
  const identity={v:1 as const,agentId:item.agentId,ownerId:item.ownerId,generation:item.generation,revision:Number(item.revision)};
  if(item.allowed===false&&item.usage===undefined)return {...identity,allowed:false};
  if(item.allowed!==true)return;
  const usage=item.usage===null?null:readAgentUsage(item.usage);if(usage===undefined)return;
  return {...identity,allowed:true,usage};
}
