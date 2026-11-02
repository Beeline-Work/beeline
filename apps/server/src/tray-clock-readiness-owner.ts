import type {SqlDatabase} from './database.js';
import {BackgroundOwnership,type BackgroundEpoch} from './background-ownership.js';
import {TrayClockReadiness} from './tray-clock-readiness.js';

/** One lifecycle batch under the existing aggregate epoch, never a second
 * leader/lease or a read-triggered initializer. The lifecycle class creates
 * transactions only through this exact ownership + actual-COMMIT boundary. */
export class TrayClockReadinessOwner{
  private current?:{epoch:BackgroundEpoch;lifecycle:TrayClockReadiness;phase:'initialize'|'seed'|'step'};
  constructor(private readonly ownership:BackgroundOwnership){}
  clear():void{this.current=undefined;}
  async run(epoch:BackgroundEpoch):Promise<Readonly<{continuation:boolean}>>{
    let current=this.current;
    if(!current||current.epoch!==epoch){
      const database:SqlDatabase={
        query:async()=>{throw new Error('Tray readiness requires an owned transaction');},
        transaction:work=>this.ownership.withTransaction(epoch,'tray.readiness',work),
      };
      current={epoch,lifecycle:new TrayClockReadiness(database),phase:'initialize'};this.current=current;
    }
    if(current.phase==='initialize'){
      await current.lifecycle.initialize();current.phase='seed';
    }
    if(current.phase==='seed'){
      const batch=await current.lifecycle.seed();
      if(batch.continuation)return Object.freeze({continuation:true});
      current.phase='step';
    }
    // A completed seed still admits one pending-work inspection. Each later
    // admission is either this batch's finite continuation or a real source.
    const batch=await current.lifecycle.step();
    return Object.freeze({continuation:batch?.continuation??false});
  }
}
