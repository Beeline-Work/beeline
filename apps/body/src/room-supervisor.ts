import { isStandingRuntimeFault, retryNotBefore } from './retry-barrier.js';

/** One attempt per actual connection/discovery/configuration boundary. Failure
 * and Retry-After never create a timer that authorizes observation. */
export class RoomSupervisor {
  readonly #parked = new Set<() => void>();
  readonly #configurationWaits = new Set<() => void>();
  #wakes = 0;
  #configurationChanges = 0;
  constructor(_legacyDelaysMs?: readonly number[]) {}
  wake(): void {this.#wakes++;for(const resume of [...this.#parked])resume();}
  configurationChanged(): void {
    this.#configurationChanges++;for(const resume of [...this.#configurationWaits])resume();this.wake();
  }
  get wakes():number{return this.#wakes;}
  /** Kept for discovery callers: the automatic retry budget is zero. */
  get retries():number{return 0;}
  retryDelay(_failures:number,signal?:AbortSignal,since=this.#wakes,notBefore=0):Promise<void>{
    return new Promise(resolve=>{
      const inspect=()=>{
        if(!signal?.aborted && (this.#wakes===since || Date.now()<notBefore))return;
        this.#parked.delete(inspect);signal?.removeEventListener('abort',inspect);resolve();
      };
      this.#parked.add(inspect);signal?.addEventListener('abort',inspect,{once:true});inspect();
    });
  }
  async supervise(label:string,signal:AbortSignal|undefined,run:(progress:()=>void)=>Promise<void>):Promise<void>{
    for(;;){
      const since=this.#wakes,configuration=this.#configurationChanges;
      try{await run(()=>undefined);return;}
      catch(error){
        if(signal?.aborted)return;
        const standing=isStandingRuntimeFault(error),notBefore=retryNotBefore(error)??0;
        console.error(`[thin-core] ${label} intake failed; waiting for ${standing?'a configuration change':'an independent recovery boundary'}:`,error);
        if(standing){
          await new Promise<void>(resolve=>{
            const inspect=()=>{
              if(!signal?.aborted && configuration===this.#configurationChanges)return;
              this.#configurationWaits.delete(inspect);signal?.removeEventListener('abort',inspect);resolve();
            };
            this.#configurationWaits.add(inspect);signal?.addEventListener('abort',inspect,{once:true});inspect();
          });
        }else await this.retryDelay(0,signal,since,notBefore);
        if(signal?.aborted)return;
      }
    }
  }
}
