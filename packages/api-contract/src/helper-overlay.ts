/** Ephemeral helper overlays are independent of durable reads and commands.
 * No client cache inventory or read-pass metadata enters this protocol. */
export const HELPER_OVERLAY_VERSION = 1;
export const HELPER_OVERLAY_MAX_BYTES = 256 * 1024;
export const HELPER_OVERLAY_MAX_FRAME_BYTES = 256 * 1024;
export interface HelperOverlayIdentity {
  readonly agentId: string;
  readonly roomId: string;
  readonly commandId: string;
  readonly turnId: string;
  readonly turnGeneration: string;
  readonly runGeneration: number;
  readonly kind: 'draft' | 'thought';
}
export interface HelperOverlayFrame extends HelperOverlayIdentity {
  readonly v: 1;
  readonly type: 'baseline' | 'append' | 'replace' | 'retract' | 'end';
  /** Monotone within command/turn generation, including harness run resets. */
  readonly revision: number;
  /** UTF-8 byte position in the acknowledged prior value. */
  readonly offset: number;
  readonly text: string;
  /** Committed server viewing revision, not a phone pass/cache certificate. */
  readonly viewingRevision: number;
}
export interface HelperOverlayDemand {
  readonly v: 1;
  readonly roomId: string;
  readonly viewing: boolean;
  readonly viewingRevision: number;
}
export type HelperOverlayAck = {readonly accepted:true;readonly revision:number} |
  {readonly accepted:false;readonly reason:'gap'|'unviewed'|'stale'|'unavailable'};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
export function readHelperOverlayFrame(value:unknown):HelperOverlayFrame|undefined {
  if(!object(value)||value.v!==1||!['baseline','append','replace','retract','end'].includes(String(value.type))||
    !['draft','thought'].includes(String(value.kind))||!integer(value.runGeneration)||!integer(value.revision)||value.revision===0||
    !integer(value.offset)||!integer(value.viewingRevision)||typeof value.text!=='string'||
    new TextEncoder().encode(value.text).length>HELPER_OVERLAY_MAX_BYTES)return;
  for(const key of ['agentId','roomId','commandId','turnId','turnGeneration'])
    if(typeof value[key]!=='string'||!value[key]||value[key].length>128)return;
  try{if(new TextEncoder().encode(JSON.stringify(value)).length>HELPER_OVERLAY_MAX_FRAME_BYTES-512)return;}catch{return;}
  if(value.type!=='append'&&value.offset!==0)return;
  if((value.type==='retract'||value.type==='end')&&value.text!=='')return;
  return value as unknown as HelperOverlayFrame;
}
export function readHelperOverlayDemand(value:unknown):HelperOverlayDemand|undefined {
  if(!object(value)||value.v!==1||typeof value.roomId!=='string'||!value.roomId||value.roomId.length>128||
    typeof value.viewing!=='boolean'||!integer(value.viewingRevision))return;
  return value as unknown as HelperOverlayDemand;
}
/** Split-surrogate/invalid UTF-8 boundaries are refused, never silently repaired. */
export function appendHelperOverlay(previous:string,offset:number,suffix:string):string|undefined {
  const bytes=new TextEncoder().encode(previous);
  if(offset!==bytes.length)return;
  const text=previous+suffix;
  if(new TextEncoder().encode(text).length>HELPER_OVERLAY_MAX_BYTES)return;
  // JSON can carry an unpaired UTF-16 surrogate; UTF-8 would replace it.
  for(const value of [previous,suffix])for(let i=0;i<value.length;i++){
    const unit=value.charCodeAt(i);
    if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return;}
    else if(unit>=0xdc00&&unit<=0xdfff)return;
  }
  return text;
}
