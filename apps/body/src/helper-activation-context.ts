import type { CommandActivationInput,CommandActivationSnapshot,CommandActivationSource } from '@beeline/api-contract/helper-activation';

export interface ActivationTransport {
  /** Independent negotiated source; capability loss cannot select legacy. */
  scope():{origin:string;source:CommandActivationSource;generation:number}|undefined;
  selected():boolean;
  read(input:CommandActivationInput):Promise<CommandActivationSnapshot>;
}

/** One in-memory setup value for the actual claimed command and connection.
 * Concurrent setup helpers share one read; transient failures recover safely.
 * No payload is persisted in the command context file, runtime journal or provider cache. */
export class CommandActivationContext {
  private selected=false;
  private held?:{key:string;result:Promise<CommandActivationSnapshot>};
  constructor(private readonly transport:ActivationTransport,private readonly now=()=>Date.now()/1000){}
  read(input:Omit<CommandActivationInput,'source'>):Promise<CommandActivationSnapshot|undefined>{
    const scope=this.transport.scope();
    if(!scope){
      if(this.selected||this.transport.selected())return Promise.reject(new Error('Activation capability unavailable; command setup remains parked'));
      return Promise.resolve(undefined);
    }
    this.selected=true;
    const key=JSON.stringify([scope.origin,scope.generation,scope.source,input.agentId,input.workspaceId,input.roomId,input.commandId,input.generationId]);
    if(this.held?.key!==key){
      const supplied={...input,source:scope.source};
      const observe=async()=>{
        const delays=[250,1000,3000];
        for(let attempt=0;;attempt++){
          if(JSON.stringify(this.transport.scope())!==JSON.stringify(scope))throw new Error('Activation command ownership changed');
          try{return await this.transport.read(supplied);}
          catch(error){
            if(attempt>=delays.length||!/unavailable|context refused|fetch failed|ECONN|timeout|timed out/i.test(String(error)))throw error;
            await new Promise(resolve=>setTimeout(resolve,delays[attempt]));
          }
        }
      };
      const result=observe().then(snapshot=>{
        const current=this.transport.scope();
        if(!current||JSON.stringify(current)!==JSON.stringify(scope)||this.held?.key!==key||
          snapshot.v!==1||snapshot.agentId!==input.agentId||snapshot.workspaceId!==input.workspaceId||snapshot.roomId!==input.roomId||
          snapshot.commandId!==input.commandId||snapshot.generationId!==input.generationId||
          snapshot.source.connectionId!==scope.source.connectionId||snapshot.source.epoch!==scope.source.epoch)
          throw new Error('Activation command ownership changed');
        return snapshot;
      });
      this.held={key,result};
      // A failed read has no effect to replay. Let a later setup consumer
      // re-observe the same command; concurrent consumers still share a flight.
      void result.catch(() => { if (this.held?.result === result) this.held = undefined; });
    }
    // Expired context cannot authorize setup; a later consumer re-observes it.
    return this.held.result.then(snapshot=>{
      if(this.held?.key!==key||JSON.stringify(this.transport.scope())!==JSON.stringify(scope))throw new Error('Activation command ownership changed');
      if(snapshot.validUntil!==undefined&&snapshot.validUntil<=this.now()){this.held=undefined;throw new Error('Activation grant context expired');}
      return snapshot;
    });
  }
}
