import type { CommandActivationInput,CommandActivationSnapshot,CommandActivationSource } from '@beeline/api-contract/helper-activation';

export interface ActivationTransport {
  /** Independent negotiated source; capability loss cannot select legacy. */
  scope():{origin:string;source:CommandActivationSource;generation:number}|undefined;
  machine():boolean;
  ready():Promise<void>;
  read(input:CommandActivationInput):Promise<CommandActivationSnapshot>;
}

/** One in-memory setup value for the actual claimed command and connection.
 * Repeated setup helpers join both success and failure. No payload is persisted
 * in the command context file, runtime journal or provider cache. */
export class CommandActivationContext {
  private held?:{key:string;commandKey:string;pending:boolean;scope:NonNullable<ReturnType<ActivationTransport['scope']>>;result:Promise<CommandActivationSnapshot>};
  constructor(private readonly transport:ActivationTransport,private readonly now=()=>Date.now()/1000){}
  async read(input:Omit<CommandActivationInput,'source'>):Promise<CommandActivationSnapshot|undefined>{
    let scope=this.transport.scope();
    if(!scope){
      if(!this.transport.machine())return undefined;
      await this.transport.ready();
      scope=this.transport.scope();
      if(!scope)throw new Error('Activation capability unavailable');
    }
    const keyFor=(value:typeof scope)=>JSON.stringify([value.origin,value.generation,value.source,input.agentId,input.workspaceId,input.roomId,input.commandId,input.generationId]);
    const key=keyFor(scope),commandKey=JSON.stringify([input.agentId,input.workspaceId,input.roomId,input.commandId,input.generationId]);
    if(this.held?.key!==key&&!(this.held?.pending&&this.held.commandKey===commandKey&&this.held.scope.origin===scope.origin)){
      const supplied={...input,source:scope.source};
      const held={key,commandKey,pending:true,scope,result:undefined as unknown as Promise<CommandActivationSnapshot>};
      held.result=this.transport.read(supplied).then(snapshot=>{
        const current=this.transport.scope();
        if(!current||current.origin!==scope.origin||this.held!==held||
          snapshot.v!==1||snapshot.agentId!==input.agentId||snapshot.workspaceId!==input.workspaceId||snapshot.roomId!==input.roomId||
          snapshot.commandId!==input.commandId||snapshot.generationId!==input.generationId||
          snapshot.source.connectionId!==current.source.connectionId||snapshot.source.epoch!==current.source.epoch)
          throw new Error('Activation command ownership changed');
        held.scope=current;held.key=keyFor(current);
        return snapshot;
      }).finally(()=>{held.pending=false;});
      this.held=held;
    }
    // Expiry is a refusal, never a new admission or observation timer.
    const held=this.held;
    return held.result.then(snapshot=>{
      if(this.held!==held||JSON.stringify(this.transport.scope())!==JSON.stringify(held.scope))throw new Error('Activation command ownership changed');
      if(snapshot.validUntil!==undefined&&snapshot.validUntil<=this.now())throw new Error('Activation grant context expired');
      return snapshot;
    });
  }
}
