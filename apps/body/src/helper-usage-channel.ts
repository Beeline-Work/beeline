import { HelperWorkQueue } from './helper-work-queue.js';
import { HelperFrameReader, sendHelperFrame } from '@beeline/net/helper-codecs';
import { helperUsageCodecs } from '@beeline/net/helper-codecs';
import { randomUUID } from 'node:crypto';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
export const HELPER_USAGE_OPERATIONS=['publishAgentUsageAccount','attachAgentUsageAccount','postAgentUsage'] as const;
export type HelperUsageOperation=typeof HELPER_USAGE_OPERATIONS[number];
/** Correlated private requests on the existing AgentChannel. One terminal
 * deadline; a sent uncertain write never falls back to HTTP or retries. */
export class HelperUsageChannel {
  private readonly pending=new Map<string,{operation:HelperUsageOperation;resolve:(value:unknown)=>void;reject:(error:Error)=>void;deadline:ReturnType<typeof setTimeout>}>();
  private readonly queue = new HelperWorkQueue(64);
  private readonly frames = new HelperFrameReader();
  constructor(private readonly send:(frame:Record<string,unknown>)=>boolean,private readonly enabled:()=>boolean){}
  suspend():void{this.queue.cancel(new Error('Helper channel ended before dispatch'));this.frames.clear();for(const pending of this.pending.values()){clearTimeout(pending.deadline);pending.reject(new Error('Usage result is awaiting confirmation'));}this.pending.clear();}
  request<N extends HelperUsageOperation>(operation:N,input:DaemonOperationMap[N]['input']):Promise<DaemonOperationMap[N]['output']>{
    return this.queue.run(() => this.dispatch(operation, input));
  }
  private dispatch<N extends HelperUsageOperation>(operation:N,input:DaemonOperationMap[N]['input']):Promise<DaemonOperationMap[N]['output']>{
    if(!this.enabled())return Promise.reject(new Error('Usage machine capability unavailable'));
    return new Promise((resolve,reject)=>{
      let parsed:DaemonOperationMap[N]['input'];
      try{parsed=helperUsageCodecs(operation).params.parse(input) as DaemonOperationMap[N]['input'];}catch(error){reject(error);return;}
      const requestId=randomUUID(),frame={type:'usage-operation',requestId,operation,input:parsed};
      const deadline=setTimeout(()=>{this.pending.delete(requestId);this.frames.discard(requestId);reject(new Error('Usage result is awaiting confirmation'));},30_000);deadline.unref?.();
      this.pending.set(requestId,{operation,resolve:value=>resolve(value as DaemonOperationMap[N]['output']),reject,deadline});
      if(!sendHelperFrame(this.send, frame)){this.pending.delete(requestId);this.frames.discard(requestId);clearTimeout(deadline);reject(new Error('Usage machine capability unavailable'));}
    });
  }
  receive(frame:Record<string,unknown>):boolean{
    if(frame.type==='usage-result-chunk'){
      if(typeof frame.requestId!=='string'||!this.pending.has(frame.requestId))return true;
      const id=frame.requestId;
      try { const complete=this.frames.receive(frame);if(!complete)return true;frame=complete; }
      catch { const pending=this.pending.get(id);this.pending.delete(id);this.frames.discard(id);
        if(pending){clearTimeout(pending.deadline);pending.reject(new Error('Malformed helper reply; outcome is UNKNOWN'));}return true; }
    }

    if(frame.type!=='usage-result')return false;
    if(typeof frame.requestId!=='string')return true;const pending=this.pending.get(frame.requestId);if(!pending)return true;
    this.pending.delete(frame.requestId);clearTimeout(pending.deadline);
    if(typeof frame.error==='string')pending.reject(new Error('Usage operation refused'));
    else {
      try{pending.resolve(helperUsageCodecs(pending.operation).result.parse(frame.result));}
      catch{pending.reject(new Error('Usage result malformed'));}
    }
    return true;
  }
}
