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
