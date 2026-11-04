import { randomUUID } from 'node:crypto';
import { helperActivationCodecs } from '@beeline/net/helper-activation-codecs';
import { COMMAND_ACTIVATION_MAX_BYTES,type CommandActivationInput,type CommandActivationSnapshot } from '@beeline/api-contract/helper-activation';

/** One bounded setup request on the existing authenticated AgentChannel.
 * Deadline/drop refuses once; no socket replacement, HTTP fallback or retry. */
export class HelperActivationChannel {
  private readonly pending=new Map<string,{resolve:(value:CommandActivationSnapshot)=>void;reject:(error:Error)=>void;deadline:ReturnType<typeof setTimeout>}>();
  constructor(private readonly send:(frame:Record<string,unknown>)=>boolean,private readonly enabled:()=>boolean){}
  suspend():void{for(const pending of this.pending.values()){clearTimeout(pending.deadline);pending.reject(new Error('Activation result unavailable'));}this.pending.clear();}
  request(input:CommandActivationInput):Promise<CommandActivationSnapshot>{
    if(this.pending.size>=16||!this.enabled())return Promise.reject(new Error('Activation channel unavailable'));
    return new Promise((resolve,reject)=>{
      let parsed:CommandActivationInput;
      try{parsed=helperActivationCodecs.params.parse(input);}catch(error){reject(error);return;}
      const requestId=randomUUID(),frame={type:'activation-context',requestId,input:parsed};
      if(Buffer.byteLength(JSON.stringify(frame))+256>COMMAND_ACTIVATION_MAX_BYTES){reject(new Error('Activation request exceeds capacity'));return;}
      const deadline=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('Activation result unavailable'));},30_000);deadline.unref?.();
      this.pending.set(requestId,{resolve,reject,deadline});
      if(!this.send(frame)){this.pending.delete(requestId);clearTimeout(deadline);reject(new Error('Activation channel unavailable'));}
    });
  }
  receive(frame:Record<string,unknown>):boolean{
    if(frame.type!=='activation-context-result')return false;
    const pending=typeof frame.requestId==='string'?this.pending.get(frame.requestId):undefined;if(!pending)return true;
    this.pending.delete(frame.requestId as string);clearTimeout(pending.deadline);
    if(Buffer.byteLength(JSON.stringify(frame))>COMMAND_ACTIVATION_MAX_BYTES||typeof frame.error==='string'){
      pending.reject(new Error('Activation context refused'));return true;
    }
    try{pending.resolve(helperActivationCodecs.result.parse(frame.result));}
    catch{pending.reject(new Error('Activation context malformed'));}
    return true;
  }
}
