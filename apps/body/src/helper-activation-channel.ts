import { HelperWorkQueue } from './helper-work-queue.js';
import { HelperFrameReader, sendHelperFrame } from '@beeline/net/helper-activation-codecs';
import { randomUUID } from 'node:crypto';
import { helperActivationCodecs } from '@beeline/net/helper-activation-codecs';
import { type CommandActivationInput,type CommandActivationSnapshot } from '@beeline/api-contract/helper-activation';

/** One bounded setup request on the existing authenticated AgentChannel.
 * Deadline/drop refuses once; no socket replacement, HTTP fallback or retry. */
export class HelperActivationChannel {
  private readonly pending=new Map<string,{resolve:(value:CommandActivationSnapshot)=>void;reject:(error:Error)=>void;deadline:ReturnType<typeof setTimeout>}>();
  private readonly queue = new HelperWorkQueue(16);
  private readonly frames = new HelperFrameReader();
  constructor(private readonly send:(frame:Record<string,unknown>)=>boolean,private readonly enabled:()=>boolean){}
  suspend():void{this.queue.cancel(new Error('Helper channel ended before dispatch'));this.frames.clear();for(const pending of this.pending.values()){clearTimeout(pending.deadline);pending.reject(new Error('Activation result unavailable'));}this.pending.clear();}
  request(input:CommandActivationInput):Promise<CommandActivationSnapshot>{
    return this.queue.run(() => this.dispatch(input));
  }
  private dispatch(input:CommandActivationInput):Promise<CommandActivationSnapshot>{
    if(!this.enabled())return Promise.reject(new Error('Activation channel unavailable'));
    return new Promise((resolve,reject)=>{
      let parsed:CommandActivationInput;
      try{parsed=helperActivationCodecs.params.parse(input);}catch(error){reject(error);return;}
      const requestId=randomUUID(),frame={type:'activation-context',requestId,input:parsed};
      const deadline=setTimeout(()=>{this.pending.delete(requestId);this.frames.discard(requestId);reject(new Error('Activation result unavailable'));},30_000);deadline.unref?.();
      this.pending.set(requestId,{resolve,reject,deadline});
      if(!sendHelperFrame(this.send, frame)){this.pending.delete(requestId);this.frames.discard(requestId);clearTimeout(deadline);reject(new Error('Activation channel unavailable'));}
    });
  }
  receive(frame:Record<string,unknown>):boolean{
    if(frame.type==='activation-context-result-chunk'){
      if(typeof frame.requestId!=='string'||!this.pending.has(frame.requestId))return true;
      const id=frame.requestId;
      try { const complete=this.frames.receive(frame);if(!complete)return true;frame=complete; }
      catch { const pending=this.pending.get(id);this.pending.delete(id);this.frames.discard(id);
        if(pending){clearTimeout(pending.deadline);pending.reject(new Error('Malformed helper reply; outcome is UNKNOWN'));}return true; }
    }

    if(frame.type!=='activation-context-result')return false;
    const pending=typeof frame.requestId==='string'?this.pending.get(frame.requestId):undefined;if(!pending)return true;
    this.pending.delete(frame.requestId as string);clearTimeout(pending.deadline);
    if(typeof frame.error==='string'){
      pending.reject(new Error('Activation context refused'));return true;
    }
    try{pending.resolve(helperActivationCodecs.result.parse(frame.result));}
    catch{pending.reject(new Error('Activation context malformed'));}
    return true;
  }
}
