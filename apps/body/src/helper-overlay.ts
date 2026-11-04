import {
  HELPER_OVERLAY_MAX_BYTES, type HelperOverlayAck, type HelperOverlayDemand,
  type HelperOverlayFrame, type HelperOverlayIdentity,
} from '@beeline/api-contract/helper-overlay';

export interface HelperOverlayTransport {
  enabled():boolean;
  subscribe(roomId:string,listener:(demand:HelperOverlayDemand)=>void):()=>void;
  send(frame:HelperOverlayFrame):Promise<HelperOverlayAck>;
}
/** Bounded one-in-flight/latest-pending uploader. No viewer means no upload;
 * a new viewing revision requires a fresh helper baseline before appends. */
export class HelperOverlayOwner {
  private text='';private acknowledged='';private revision=0;private runGeneration=0;
  private demand:HelperOverlayDemand;private baseline=false;private stopped=false;
  private inFlight:Promise<void>|undefined;private dirty=false;private release:()=>void;
  constructor(private readonly identity:Omit<HelperOverlayIdentity,'runGeneration'>,
    private readonly transport:HelperOverlayTransport){
    this.demand={v:1,roomId:identity.roomId,viewing:false,viewingRevision:0};
    this.release=transport.subscribe(identity.roomId,demand=>{
      if(demand.viewingRevision<this.demand.viewingRevision)return;
      if(demand.viewingRevision===this.demand.viewingRevision&&demand.viewing===this.demand.viewing)return;
      this.demand=demand;this.baseline=false;this.dirty=true;this.flush();
    });
  }
  update(text:string):void {
    if(this.stopped)return;
    if(Buffer.byteLength(text)>HELPER_OVERLAY_MAX_BYTES)throw new Error('Helper overlay exceeds capacity');
    this.text=text;this.dirty=true;this.flush();
  }
  beginRun():void {if(this.stopped)return;this.runGeneration++;this.text='';this.baseline=false;this.dirty=true;this.flush();}
  private flush():void {
    if(this.stopped||this.inFlight||!this.dirty||!this.transport.enabled()||!this.demand.viewing)return;
    this.dirty=false;
    const text=this.text,demand=this.demand,run=this.runGeneration;
    const baseline=!this.baseline;
    const append=!baseline&&text.startsWith(this.acknowledged);
    const frame:HelperOverlayFrame={...this.identity,v:1,runGeneration:run,
      type:baseline?'baseline':append?'append':'replace',revision:++this.revision,
      offset:append?Buffer.byteLength(this.acknowledged):0,text:append?text.slice(this.acknowledged.length):text,
      viewingRevision:demand.viewingRevision};
    this.inFlight=this.transport.send(frame).then(ack=>{
      if(this.stopped||demand!==this.demand||run!==this.runGeneration)return;
      if(ack.accepted){this.acknowledged=text;this.baseline=true;}
      else{
        // A negative acknowledgement parks this revision. Only a new actual
        // demand/run/token update may admit another frame; no failure retry.
        this.baseline=false;this.dirty=false;
      }
    }).catch(()=>{if(demand===this.demand){this.baseline=false;this.dirty=false;}}).finally(()=>{
      this.inFlight=undefined;if(this.dirty)this.flush();
    });
  }
  async close(type:'retract'|'end'='end'):Promise<void>{
    if(this.stopped)return;this.stopped=true;this.release();await this.inFlight;
    if(!this.transport.enabled()||!this.demand.viewing||!this.baseline)return;
    await this.transport.send({...this.identity,v:1,runGeneration:this.runGeneration,type,
      revision:++this.revision,offset:0,text:'',viewingRevision:this.demand.viewingRevision}).catch(()=>undefined);
  }
}
