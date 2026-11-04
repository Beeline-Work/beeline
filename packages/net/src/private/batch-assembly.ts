import type { LaneBatch, LaneCut, LaneFact, LaneClassification } from './read-lanes.js';
import { jsonBytes as bytes, remember } from './staging-bounds.js';
export type RouterPart = Readonly<{ kind: 'push-part'; batchId: string; from: LaneCut; to: LaneCut;
  partIndex: number; partCount: number; contentDigest: string; facts: readonly (LaneFact | LaneClassification)[] }>;
export type RouterCommit = Readonly<{ kind: 'push-commit'; batchId: string; from: LaneCut; to: LaneCut;
  partCount: number; contentDigest: string }>;
type Position = LaneCut & {readonly segment?:string};
export type MultipartHeader<P extends Position> = Readonly<{batchId:string;from:P;to:P;partCount:number;contentDigest:string}>;
export type MultipartBatch<T,P extends Position,E extends object={}> = {
  frame:MultipartHeader<P>;signature:string;parts:Map<number,readonly T[]>;bytes:number;commit:boolean;
}&Partial<E>;
export const positionKey=(value:Position)=>[value.stream,value.epoch,value.segment,value.through,value.protocol];
export const multipartIdentity=<P extends Position>(frame:MultipartHeader<P>)=>JSON.stringify([
  frame.batchId,positionKey(frame.from),positionKey(frame.to),frame.partCount,frame.contentDigest,
]);
export function multipartRecords<T,P extends Position>(batch:MultipartBatch<T,P>):T[]|undefined{
  if(!batch.commit||batch.parts.size!==batch.frame.partCount)return;
  return Array.from({length:batch.frame.partCount},(_,index)=>batch.parts.get(index)!).flat();
}
/** Shared physical ownership only. Callers validate their closed wire schema,
 * verify digests and own publication/authority ordering. Keeping asynchronous
 * authority proofs out of this map preserves synchronous data assembly. */
export class Multipart<T,P extends Position,E extends object={}> extends Map<string,MultipartBatch<T,P,E>>{
  constructor(_ordered=false){super();}
  accept(frame:MultipartHeader<P>,part?:Readonly<{index:number;values:readonly T[]}>):MultipartBatch<T,P,E>|'protocol'|'continuity'|'digest'|'budget'{
    if(!Number.isInteger(frame.partCount)||frame.partCount<1||part&&
      (!Number.isInteger(part.index)||part.index<0||part.index>=frame.partCount))return'protocol';
    const signature=multipartIdentity(frame);let batch=this.get(frame.batchId);
    if(!batch){
      const header={batchId:frame.batchId,from:frame.from,to:frame.to,partCount:frame.partCount,contentDigest:frame.contentDigest};
      batch={frame:JSON.parse(JSON.stringify(header)) as MultipartHeader<P>,signature,parts:new Map(),bytes:0,commit:false} as MultipartBatch<T,P,E>;
      this.set(frame.batchId,batch);
    }
    if(batch.signature!==signature)return'continuity';
    if(!part)batch.commit=true;
    else{
      const previous=batch.parts.get(part.index);
      if(previous&&JSON.stringify(previous)!==JSON.stringify(part.values))return'digest';
      if(!previous){
        batch.parts.set(part.index,JSON.parse(JSON.stringify(part.values)) as T[]);batch.bytes+=bytes(part.values);
      }
    }
    return batch;
  }
}

/** Complete staging. Neither a part nor a commit alone can advance a cut.
 * Digest is injected by the trusted platform adapter; this module imports no SDK.
 */
export class RouterBatchAssembly {
  private readonly streams = new Map<string, Multipart<LaneFact|LaneClassification,LaneCut>>();
  private readonly completed = new Map<string, string>();
  constructor(private readonly digest: (facts: readonly (LaneFact | LaneClassification)[]) => string,
    private readonly commit: (batch: LaneBatch) => void,
    private readonly fault: (stream: string) => void) {}

  accept(frame: RouterPart | RouterCommit): void {
    const stream = frame.to.stream;
    const invalid = !frame.batchId || frame.batchId.length > 128 || !frame.contentDigest ||
      frame.contentDigest.length > 128 || frame.from.stream !== stream || frame.from.epoch !== frame.to.epoch ||
      frame.from.protocol !== 1 || frame.to.protocol !== 1 || !Number.isSafeInteger(frame.from.through) ||
      !Number.isSafeInteger(frame.to.through) || frame.from.through < 0 || frame.to.through < frame.from.through;
    if (invalid) { this.fail(stream); return; }
    const signature = multipartIdentity(frame);
    const completed = this.completed.get(`${stream}\0${frame.batchId}`);
    if (completed) { if (completed !== signature) this.fail(stream); return; }
    let batches = this.streams.get(stream);
    if (!batches) { batches = new Multipart(); this.streams.set(stream, batches); }
    const batch=batches.accept(frame,frame.kind==='push-part'?{index:frame.partIndex,values:frame.facts}:undefined);
    if(typeof batch==='string'){this.fail(stream);return;}
    const records=multipartRecords(batch);if(!records)return;
    const markers=records.filter((record):record is LaneClassification=>'kind' in record);
    if(markers.length>1){this.fail(stream);return;}
    const facts=records.filter((record):record is LaneFact=>!('kind' in record));
    if (this.digest(records) !== frame.contentDigest) { this.fail(stream); return; }
    batches.delete(frame.batchId);
    if (!batches.size) this.streams.delete(stream);
    remember(this.completed, `${stream}\0${frame.batchId}`, signature);
    this.commit({ from: batch.frame.from, to: batch.frame.to, facts,
      ...(facts.some(fact=>fact.payload.kind==='tray-classification')?{contentDigest:frame.contentDigest}:{}),
      ...(markers[0]?{scheduledWorkClassification:markers[0]}:{}) });
  }
  reset(): void { this.streams.clear(); this.completed.clear(); }
  private fail(stream: string): void { this.streams.delete(stream); this.fault(stream); }
}
