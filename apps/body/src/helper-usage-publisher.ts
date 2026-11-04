import { createHash } from 'node:crypto';
import type { AgentUsage } from '@beeline/api-contract/daemon';
import { canonicalUsageAccountSnapshot, type UsageAccountPublicationResult, type UsageAccountReference, type UsageAccountSource } from '@beeline/api-contract/helper-usage';
export interface UsageAccountTransport {
  scope():{origin:string;ownerId:string;generation:number;source:UsageAccountSource}|undefined;
  publish(input:{agentId:string;usage:AgentUsage;revision:string;ownerId:string;source:UsageAccountSource}):Promise<UsageAccountPublicationResult>;
  attach(input:{agentId:string}&UsageAccountReference):Promise<unknown>;
}
interface Publication {revision:string;publisher:string;actor:string;state:'pending'|'confirmed'|'uncertain';result:Promise<UsageAccountPublicationResult>}
interface AccountSlot {publication?:Publication;attached:Set<string>;attaching:Map<string,Promise<void>>;actors:Map<string,string>}
/** A provider account revision is published once in its authenticated owner
 * namespace. Siblings attach once; subsequent shared reads post no snapshot. */
export class UsageAccountPublisher {
  constructor(private readonly transport:UsageAccountTransport,private readonly accounts=new Map<string,AccountSlot>(),
    private readonly activeAccounts=new Map<string,string>()){}
  async deliver(agentId:string,usage:AgentUsage):Promise<boolean>{
    const scope=this.transport.scope();if(!scope||!usage.account)return false;
    const key=JSON.stringify([scope.origin,scope.ownerId,usage.account.provider,usage.account.key]);
    const agentKey=JSON.stringify([scope.origin,scope.ownerId,agentId]),previous=this.activeAccounts.get(agentKey);
    if(previous&&previous!==key){this.accounts.get(previous)?.attached.delete(agentId);this.accounts.get(previous)?.attaching.delete(agentId);}
    if(!this.activeAccounts.has(agentKey)&&this.activeAccounts.size>=4096)throw new Error('Usage attachment capacity exceeded');
    this.activeAccounts.set(agentKey,key);
    let slot=this.accounts.get(key);
    if(!slot){if(this.accounts.size>=256)throw new Error('Usage publication capacity exceeded');
      slot={attached:new Set(),attaching:new Map(),actors:new Map()};this.accounts.set(key,slot);}
    const revision=createHash('sha256').update(canonicalUsageAccountSnapshot(usage,scope.ownerId)).digest('hex');
    const actor=JSON.stringify([scope.generation,scope.source.connectionId,scope.source.epoch]);
    const previousActor=slot.actors.get(agentId),changedActor=previousActor!==undefined&&previousActor!==actor;
    slot.actors.set(agentId,actor);if(changedActor){slot.attaching.delete(agentId);slot.attached.delete(agentId);}
    if(slot.publication?.revision!==revision || changedActor&&slot.publication.state!=='confirmed'){
      const publication:Publication={revision,publisher:agentId,actor,state:'pending',result:undefined as unknown as Promise<UsageAccountPublicationResult>};
      publication.result=this.transport.publish({agentId,usage,revision,ownerId:scope.ownerId,source:scope.source}).then(result=>{
        if(result.ownerId!==scope.ownerId||!/^[a-f0-9]{64}$/.test(result.revision)||!/^\d+$/.test(result.accountId)){
          publication.state='uncertain';throw new Error('Invalid usage publication receipt');
        }
        publication.state='confirmed';return result;
      },error=>{publication.state='uncertain';throw error;});
      slot.publication=publication;slot.attaching.clear();
    }
    const publication=slot.publication;
    const result=await publication.result;
    if(!/^[a-f0-9]{64}$/.test(result.revision)||!/^\d+$/.test(result.accountId))throw new Error('Invalid usage publication receipt');
    const current=this.transport.scope();
    if(!current||current.origin!==scope.origin||current.ownerId!==scope.ownerId||result.ownerId!==scope.ownerId||current.generation!==scope.generation||current.source.connectionId!==scope.source.connectionId||current.source.epoch!==scope.source.epoch)
      throw new Error('Usage publication owner changed');
    if(publication.publisher===agentId&&publication.actor===actor)slot.attached.add(agentId);
    if(slot.attached.has(agentId))return true;
    let attaching=slot.attaching.get(agentId);
    if(!attaching){
      attaching=this.transport.attach({agentId,account:usage.account,revision:result.revision,source:scope.source}).then(()=>{
        const latest=this.transport.scope();
        if(!latest||JSON.stringify([latest.generation,latest.source.connectionId,latest.source.epoch])!==actor||
          latest.origin!==scope.origin||latest.ownerId!==scope.ownerId||slot.actors.get(agentId)!==actor)
          throw new Error('Usage attachment owner changed');
        slot.attached.add(agentId);
      });
      slot.attaching.set(agentId,attaching);
    }
    await attaching;return true;
  }
}

const sharedAccountPublications=new Map<string,AccountSlot>();
const sharedActiveAccounts=new Map<string,string>();
/** Each agent keeps its authenticated transport; shared slots stop at an
 * account/owner/origin namespace, never at a machine-wide credential guess. */
export function createUsageAccountPublisher(transport:UsageAccountTransport):UsageAccountPublisher{
  return new UsageAccountPublisher(transport,sharedAccountPublications,sharedActiveAccounts);
}

export function invalidateUsageAccountAttachment(origin:string,ownerId:string,agentId:string):void{
  const key=JSON.stringify([origin,ownerId,agentId]),account=sharedActiveAccounts.get(key);
  if(account){sharedAccountPublications.get(account)?.attached.delete(agentId);sharedAccountPublications.get(account)?.attaching.delete(agentId);}
  sharedActiveAccounts.delete(key);
}
