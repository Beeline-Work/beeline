import { canonicalUsagePayload } from '@beeline/api-contract/helper-usage';
import type { AgentUsage } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';
import { createUsageAccountPublisher } from './helper-usage-publisher.js';
/** Existing DaemonApiClient owns all transport; this adapter never fetches. */
export function helperUsageBinding(api:DaemonApiClient){
  const scope=()=>api.channel?.usageAccountScope?.();
  const publisher=createUsageAccountPublisher({scope,
    publish:input=>api.execute('publishAgentUsageAccount',input),
    attach:input=>api.execute('attachAgentUsageAccount',input)});
  return {
    scopeKey():string{const current=scope();return current?JSON.stringify(['account-v1',current.origin,current.ownerId]):api.channel?.isOpen?'machine':'legacy';},
    publicationKey():string{return JSON.stringify(scope()??(api.channel?.isOpen?'machine':'legacy'));},
    captureSource():()=>boolean{const captured=JSON.stringify(scope());return()=>JSON.stringify(scope())===captured;},
    async deliver(usage:AgentUsage):Promise<boolean>{
      let current=scope();
      if(Boolean(api.channel?.isOpen)&&(!api.channel.isOpen()||!current)){
        await api.waitForConnection();current=scope();
        if(!current)throw new Error('Usage account capability unavailable');
      }
      return publisher.deliver(api.agentId,usage);
    },
  };
}

const contextWrites=new Map<string,{actor:string;sequence:number;digest?:string;pending?:Promise<unknown>}>();
/** Existing context/key-spend calls share one ordered source per authenticated
 * agent actor. Repeated context values join; uncertainty never starts retries. */
export async function postChangedAgentUsage(api:DaemonApiClient,agentId:string,usage:AgentUsage):Promise<unknown>{
  let scope=api.channel?.usageAccountScope?.();
  if(Boolean(api.channel?.isOpen)&&(!api.channel.isOpen()||!scope)){
    await api.waitForConnection();scope=api.channel?.usageAccountScope?.();
    if(!scope)throw new Error('Usage source unavailable');
  }
  if(!scope){
    return api.execute('postAgentUsage',{agentId,usage});
  }
  const key=JSON.stringify([scope.origin,scope.ownerId,agentId]),actor=JSON.stringify(scope.source);
  let writer=contextWrites.get(key);
  if(!writer){if(contextWrites.size>=4096)return Promise.reject(new Error('Usage source capacity exceeded'));
    writer={actor,sequence:0};contextWrites.set(key,writer);}
  if(writer.actor!==actor){writer.actor=actor;writer.sequence=0;writer.digest=undefined;writer.pending=undefined;}
  const contextOnly=!usage.windows.length&&!usage.account&&!usage.spend&&!usage.plan&&!usage.credits&&!usage.read;
  const digest=canonicalUsagePayload(contextOnly?{...usage,updatedAt:0}:usage);
  if(writer.digest===digest&&writer.pending)return writer.pending;
  writer.digest=digest;
  writer.pending=api.execute('postAgentUsage',{agentId,usage,usageSource:{v:1,ownerId:scope.ownerId,source:scope.source,revision:++writer.sequence}});
  return writer.pending;
}
