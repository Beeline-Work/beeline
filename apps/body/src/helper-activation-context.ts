import type { CommandActivationInput,CommandActivationSnapshot,CommandActivationSource } from '@beeline/api-contract/helper-activation';

export interface ActivationTransport {
  /** Independent negotiated source; capability loss cannot select legacy. */
  scope():{origin:string;source:CommandActivationSource;generation:number}|undefined;
  selected():boolean;
  read(input:CommandActivationInput):Promise<CommandActivationSnapshot>;
}

/** One in-memory setup value for the actual claimed command and connection.
 * Repeated setup helpers join both success and failure. No payload is persisted
 * in the command context file, runtime journal or provider cache. */
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
      const result=this.transport.read(supplied).then(snapshot=>{
        const current=this.transport.scope();
        if(!current||JSON.stringify(current)!==JSON.stringify(scope)||this.held?.key!==key||
          snapshot.v!==1||snapshot.agentId!==input.agentId||snapshot.workspaceId!==input.workspaceId||snapshot.roomId!==input.roomId||
          snapshot.commandId!==input.commandId||snapshot.generationId!==input.generationId||
          snapshot.source.connectionId!==scope.source.connectionId||snapshot.source.epoch!==scope.source.epoch)
          throw new Error('Activation command ownership changed');
        return snapshot;
      });
      this.held={key,result};
    }
    // Expiry is a refusal, never a new admission or observation timer.
    return this.held.result.then(snapshot=>{
      if(this.held?.key!==key||JSON.stringify(this.transport.scope())!==JSON.stringify(scope))throw new Error('Activation command ownership changed');
      if(snapshot.validUntil!==undefined&&snapshot.validUntil<=this.now())throw new Error('Activation grant context expired');
      return snapshot;
    });
  }
}
