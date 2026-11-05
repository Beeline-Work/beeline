import { randomUUID } from 'node:crypto';
import { helperActivationCodecs } from '@beeline/net/helper-activation-codecs';
import { type CommandActivationInput,type CommandActivationSnapshot } from '@beeline/api-contract/helper-activation';

/** Read-only setup requests follow registration across socket loss. The
 * machine's existing reconnect/heartbeat owns recovery; no read timer or cap. */
export class HelperActivationChannel {
  private readonly pending=new Map<string,{input:CommandActivationInput;frame:Record<string,unknown>;sent:boolean;resolve:(value:CommandActivationSnapshot)=>void;reject:(error:Error)=>void}>();
  constructor(private readonly send:(frame:Record<string,unknown>)=>boolean,private readonly enabled:()=>boolean){}
  suspend():void{for(const pending of this.pending.values())pending.sent=false;}
  stop():void{for(const pending of this.pending.values())pending.reject(new Error('Activation channel ended'));this.pending.clear();}
  resume(source:CommandActivationInput['source']|undefined):void{
    if(!source){this.stop();return;}
    for(const [requestId,pending] of [...this.pending]){
      if(pending.sent)continue;
      this.pending.delete(requestId);
      pending.input={...pending.input,source};
      this.dispatch(pending);
    }
  }
  private dispatch(pending:{input:CommandActivationInput;frame:Record<string,unknown>;sent:boolean;resolve:(value:CommandActivationSnapshot)=>void;reject:(error:Error)=>void}):void{
    // A fresh correlation ignores a late response from the disconnected socket.
    const requestId=randomUUID();
    this.pending.set(requestId,pending);
    pending.frame={...pending.frame,requestId,input:pending.input};
    pending.sent=this.send(pending.frame);
  }
  request(input:CommandActivationInput):Promise<CommandActivationSnapshot>{
    if(!this.enabled())return Promise.reject(new Error('Activation channel unavailable'));
    return new Promise((resolve,reject)=>{
      let parsed:CommandActivationInput;
      try{parsed=helperActivationCodecs.params.parse(input);}catch(error){reject(error);return;}
      this.dispatch({input:parsed,frame:{type:'activation-context'},sent:false,resolve,reject});
    });
  }
  receive(frame:Record<string,unknown>):boolean{
    if(frame.type!=='activation-context-result')return false;
    const pending=typeof frame.requestId==='string'?this.pending.get(frame.requestId):undefined;if(!pending)return true;
    this.pending.delete(frame.requestId as string);
    if(typeof frame.error==='string'){
      pending.reject(new Error('Activation context refused'));return true;
    }
    try{pending.resolve(helperActivationCodecs.result.parse(frame.result));}
    catch{pending.reject(new Error('Activation context malformed'));}
    return true;
  }
}
