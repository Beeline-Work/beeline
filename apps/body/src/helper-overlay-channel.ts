import { HelperWorkQueue } from './helper-work-queue.js';
import { randomUUID } from 'node:crypto';
import { HELPER_OVERLAY_MAX_FRAME_BYTES, readHelperOverlayDemand, type HelperOverlayAck, type HelperOverlayDemand, type HelperOverlayFrame } from '@beeline/api-contract/helper-overlay';
import type { HelperOverlayTransport } from './helper-overlay.js';

/** The existing authenticated AgentChannel owns this capability and transport.
 * It never opens a socket, retries a frame, or performs an application read. */
export class HelperOverlayChannel implements HelperOverlayTransport {
  private supported=false;
  private wasSelected=false;
  private readonly demands=new Map<string,HelperOverlayDemand>();
  private readonly listeners=new Map<string,Set<(demand:HelperOverlayDemand)=>void>>();
  private readonly pending=new Map<string,{revision:number;resolve:(ack:HelperOverlayAck)=>void;deadline:ReturnType<typeof setTimeout>}>();
  private readonly queue = new HelperWorkQueue(128);
  constructor(private readonly write:(frame:Record<string,unknown>)=>boolean,private readonly isOpen:()=>boolean){}
  enabled():boolean{return this.supported&&this.isOpen();}
  selected():boolean{return this.wasSelected;}
  negotiate(enabled:boolean):void{this.supported=enabled;if(enabled)this.wasSelected=true;}
  suspend():void{
    this.queue.cancel(new Error('Overlay channel ended before dispatch'));
    this.supported=false;
    for(const pending of this.pending.values()){clearTimeout(pending.deadline);pending.resolve({accepted:false,reason:'unavailable'});}this.pending.clear();
    for(const [roomId,demand]of this.demands){const paused={...demand,viewing:false};this.demands.set(roomId,paused);
      for(const listener of this.listeners.get(roomId)??[])listener(paused);}
  }
  subscribe(roomId:string,listener:(demand:HelperOverlayDemand)=>void):()=>void{
    let listeners=this.listeners.get(roomId);if(!listeners){listeners=new Set();this.listeners.set(roomId,listeners);}
    listeners.add(listener);const current=this.demands.get(roomId);if(current)listener(current);
    return()=>{listeners.delete(listener);if(!listeners.size)this.listeners.delete(roomId);};
  }
  receive(event:Record<string,unknown>):boolean{
    if(event.type==='overlay-demand'){
      if(!this.enabled())return true;
      const demand=readHelperOverlayDemand(event);if(!demand)return true;
      const previous=this.demands.get(demand.roomId);if(previous&&previous.viewingRevision>demand.viewingRevision)return true;
      if(!this.demands.has(demand.roomId)&&this.demands.size>=8192)return true;
      this.demands.set(demand.roomId,demand);for(const listener of this.listeners.get(demand.roomId)??[])listener(demand);
      return true;
    }
    if(event.type!=='overlay-ack')return false;
    if(typeof event.requestId!=='string')return true;
    const pending=this.pending.get(event.requestId);if(!pending)return true;
    this.pending.delete(event.requestId);clearTimeout(pending.deadline);
    pending.resolve(event.accepted===true&&event.revision===pending.revision?{accepted:true,revision:pending.revision}:
      {accepted:false,reason:['gap','unviewed','stale','unavailable'].includes(String(event.reason))?event.reason as 'gap':'unavailable'});
    return true;
  }
  send(frame:HelperOverlayFrame):Promise<HelperOverlayAck>{
    return this.queue.run(() => this.dispatch(frame)).catch(() => ({accepted:false,reason:'unavailable'}));
  }
  private dispatch(frame:HelperOverlayFrame):Promise<HelperOverlayAck>{
    if(!this.enabled())return Promise.resolve({accepted:false,reason:'unavailable'});
    return new Promise(resolve=>{
      const requestId=randomUUID();
      const envelope={type:'overlay-update',requestId,frame};
      if(Buffer.byteLength(JSON.stringify({...envelope,agentId:frame.agentId}))>HELPER_OVERLAY_MAX_FRAME_BYTES){resolve({accepted:false,reason:'unavailable'});return;}
      const deadline=setTimeout(()=>{
        this.pending.delete(requestId);resolve({accepted:false,reason:'unavailable'});
      },30_000);deadline.unref?.();
      this.pending.set(requestId,{revision:frame.revision,resolve,deadline});
      if(!this.write(envelope)){
        this.pending.delete(requestId);clearTimeout(deadline);resolve({accepted:false,reason:'unavailable'});
      }
    });
  }
}
