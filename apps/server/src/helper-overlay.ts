import {
  HELPER_OVERLAY_MAX_FRAME_BYTES, appendHelperOverlay, readHelperOverlayFrame, type HelperOverlayAck,
  type HelperOverlayDemand, type HelperOverlayFrame,
} from '@beeline/api-contract/helper-overlay';
import { authorizeCommandOutput } from './agent-command.js';
import { subscribeCommandCompletion } from './command-completion.js';
import type { SqlDatabase } from './database.js';
import type { LiveEvent } from './live.js';
import { ROUTER_AUTHORITY_LOCK } from './router-projection-schema.js';
import { SERVER_LEASE_EXPIRY_MS } from './connection-presence.js';

/** Independent deployment gate. Never infer support from native/helper version. */
export const helperOverlayEnabled=()=>process.env.BEELINE_HELPER_OVERLAY_V1==='1';
export const HELPER_OVERLAY_SCHEMA=`
CREATE TABLE IF NOT EXISTS helper_overlay_demand(room_id uuid PRIMARY KEY,revision bigint NOT NULL DEFAULT 0);
CREATE OR REPLACE FUNCTION beeline_helper_overlay_demand(room uuid) RETURNS void AS $$
BEGIN
 INSERT INTO helper_overlay_demand(room_id,revision) VALUES(room,1)
 ON CONFLICT(room_id) DO UPDATE SET revision=helper_overlay_demand.revision+1;
 PERFORM pg_notify('beeline_command_completion',json_build_object('principal','overlay','operation','viewers','commandId',room)::text);
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION beeline_helper_overlay_view_source() RETURNS trigger AS $$
DECLARE item jsonb; room uuid;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NULL;END IF;
 item:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='room_push_views' THEN
   PERFORM beeline_helper_overlay_demand((item->>'room_id')::uuid);
 ELSE
   IF TG_OP='UPDATE' AND ROW(NEW.removed_at,NEW.role) IS NOT DISTINCT FROM ROW(OLD.removed_at,OLD.role) THEN RETURN NULL;END IF;
   FOR room IN SELECT DISTINCT view.room_id FROM room_push_views view JOIN rooms r ON r.id=view.room_id
     WHERE view.identity_id=item->>'identity_id' AND r.workspace_id=(item->>'workspace_id')::uuid
   LOOP PERFORM beeline_helper_overlay_demand(room);END LOOP;
 END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_helper_overlay_view_source ON room_push_views;
CREATE TRIGGER beeline_helper_overlay_view_source AFTER INSERT OR UPDATE OR DELETE ON room_push_views
 FOR EACH ROW EXECUTE FUNCTION beeline_helper_overlay_view_source();
DROP TRIGGER IF EXISTS beeline_helper_overlay_view_source ON memberships;
CREATE TRIGGER beeline_helper_overlay_view_source AFTER INSERT OR UPDATE OR DELETE ON memberships
 FOR EACH ROW EXECUTE FUNCTION beeline_helper_overlay_view_source();
INSERT INTO helper_overlay_demand(room_id,revision) SELECT DISTINCT room_id,1 FROM room_push_views ON CONFLICT DO NOTHING;
`;
export async function helperOverlayDemand(db:Pick<SqlDatabase,'query'>,roomId:string):Promise<HelperOverlayDemand>{
  const row=(await db.query<{revision:string;viewing:boolean}>(`SELECT COALESCE((SELECT revision::text FROM helper_overlay_demand WHERE room_id=$1),'0') revision,
    EXISTS(SELECT 1 FROM room_push_views view JOIN room_access access ON access.room_id=view.room_id
      AND access.identity_id=view.identity_id AND access.removed_at IS NULL
      JOIN rooms room ON room.id=view.room_id AND room.archived_at IS NULL
      JOIN memberships workspace ON workspace.workspace_id=room.workspace_id AND workspace.room_id IS NULL
        AND workspace.identity_id=view.identity_id AND workspace.removed_at IS NULL
      WHERE view.room_id=$1 AND (view.expires_at IS NULL OR view.expires_at>clock_timestamp()) AND
        (view.instance_id IS NULL OR EXISTS(SELECT 1 FROM live_server_instances instance
          WHERE instance.instance_id=view.instance_id AND instance.renewed_at>clock_timestamp()-make_interval(secs=>$2::double precision/1000)))) viewing`,
    [roomId,SERVER_LEASE_EXPIRY_MS])).rows[0]!;
  const revision=Number(row.revision);if(!Number.isSafeInteger(revision))throw new Error('Overlay viewing revision overflow');
  return {v:1,roomId,viewing:row.viewing,viewingRevision:revision};
}
export function subscribeHelperOverlayDemand(db:SqlDatabase,roomId:string,send:(demand:HelperOverlayDemand)=>void):()=>void{
  let closed=false,running=false,dirty=true;
  const drain=async()=>{
    if(closed||running)return;running=true;
    try{while(dirty&&!closed){dirty=false;const current=await helperOverlayDemand(db,roomId);if(!closed)send(current);}}
    catch{/* Failed observation parks until another committed source/recovery. */}
    finally{running=false;}
  };
  const release=subscribeCommandCompletion({principal:'overlay',operation:'viewers',commandId:roomId},()=>{dirty=true;void drain();});
  void drain();return()=>{closed=true;release();};
}
export interface HelperOverlayMetadata extends HelperOverlayFrame {
  readonly connectionId:string;readonly connectionEpoch:number;
}
export type HelperOverlayLiveEvent=Extract<LiveEvent,{type:'draft'|'thought'}>&{overlayV1:HelperOverlayMetadata} |
  Extract<LiveEvent,{type:'retract'}>&{overlayV1:HelperOverlayMetadata};
export function helperOverlayMetadata(value:unknown):HelperOverlayMetadata|undefined{
  if(!value||typeof value!=='object')return;const item=value as Record<string,unknown>;
  const parsed=readHelperOverlayFrame({...item,text:''});
  if(!parsed||typeof item.connectionId!=='string'||!Number.isSafeInteger(item.connectionEpoch)||Number(item.connectionEpoch)<1)return;
  return item as unknown as HelperOverlayMetadata;
}
export function helperOverlayEvent(body:Record<string,unknown>):HelperOverlayLiveEvent|undefined{
  const metadata=helperOverlayMetadata(body.overlayV1);if(!metadata||typeof body.text!=='string')return;
  if(metadata.type==='end'||metadata.type==='retract')return {type:'retract',roomId:metadata.roomId,agentId:metadata.agentId,
    turnId:metadata.turnId,kind:metadata.kind,overlayV1:metadata};
  return {type:metadata.kind,roomId:metadata.roomId,agentId:metadata.agentId,turnId:metadata.turnId,text:body.text,overlayV1:metadata};
}
async function currentOwner(db:SqlDatabase,metadata:HelperOverlayMetadata):Promise<boolean>{
  const row=await db.query(`SELECT 1 FROM agent_connections WHERE agent_id=$1 AND connection_id=$2 AND epoch=$3
    AND released_at IS NULL FOR SHARE`,[metadata.agentId,metadata.connectionId,metadata.connectionEpoch]);
  if(!row.rowCount)return false;
  const command=await authorizeCommandOutput(db,metadata.roomId,metadata.agentId,metadata.turnId,metadata.turnGeneration,
    metadata.type==='end'||metadata.type==='retract');
  if(command.id!==metadata.commandId)return false;
  if((await db.query(`SELECT 1 FROM agent_commands newer JOIN agent_commands current ON current.id=$1
    WHERE newer.room_id=current.room_id AND newer.agent_id=current.agent_id AND newer.state='claimed'
      AND (newer.created_at,newer.id)>(current.created_at,current.id)`,[command.id])).rowCount)return false;
  return !(await db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3
    AND generation_id=$4 AND status IN ('complete','failed','cancelled')`,
    [metadata.roomId,metadata.agentId,metadata.turnId,metadata.turnGeneration])).rowCount;
}
/** Caller authenticates the agent and pins the actual machine registration.
 * Every token is still authorized against current command and Room authority. */
export async function applyHelperOverlay(db:SqlDatabase,authenticatedAgentId:string,
  owner:{connectionId:string;epoch:number},raw:unknown):Promise<{ack:HelperOverlayAck;event?:HelperOverlayLiveEvent}>{
  const frame=readHelperOverlayFrame(raw);
  if(!frame||frame.agentId!==authenticatedAgentId||appendHelperOverlay('',0,frame.text)===undefined)
    return {ack:{accepted:false,reason:'stale'}};
  const {text:_text,...control}=frame;
  const metadata:HelperOverlayMetadata={...control,text:'',connectionId:owner.connectionId,connectionEpoch:owner.epoch};
  try{return await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
    if(!await currentOwner(tx,metadata))return {ack:{accepted:false,reason:'stale'}};
    if(!(await tx.query(`SELECT 1 FROM room_access access JOIN rooms room ON room.id=access.room_id
      JOIN memberships workspace ON workspace.workspace_id=room.workspace_id AND workspace.identity_id=access.identity_id
      AND workspace.room_id IS NULL AND workspace.removed_at IS NULL
      WHERE access.room_id=$1 AND access.identity_id=$2 AND access.removed_at IS NULL AND room.archived_at IS NULL`,
      [frame.roomId,frame.agentId])).rowCount)return {ack:{accepted:false,reason:'stale'}};
    const demand=await helperOverlayDemand(tx,frame.roomId);
    if(!demand.viewing)return {ack:{accepted:false,reason:'unviewed'}};
    if(demand.viewingRevision!==frame.viewingRevision)return {ack:{accepted:false,reason:'gap'}};
    const prior=(await tx.query<{body:Record<string,unknown>}>(`SELECT body FROM live_outputs
      WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind=$4 FOR UPDATE`,
      [frame.roomId,frame.agentId,frame.turnId,frame.kind])).rows[0]?.body;
    const old=helperOverlayMetadata(prior?.overlayV1);
    const same=old?.commandId===frame.commandId&&old.turnGeneration===frame.turnGeneration;
    if(same&&(old.runGeneration>frame.runGeneration||old.revision>=frame.revision||
      old.type==='end'||old.type==='retract'))return {ack:{accepted:false,reason:'stale'}};
    const baseline=frame.type==='baseline';
    if(!baseline&&(!same||old?.runGeneration!==frame.runGeneration||old.viewingRevision!==frame.viewingRevision||
      old.revision+1!==frame.revision))return {ack:{accepted:false,reason:'gap'}};
    let text=frame.text;
    if(frame.type==='append'){
      const appended=appendHelperOverlay(typeof prior?.text==='string'?prior.text:'',frame.offset,frame.text);
      if(appended===undefined)return {ack:{accepted:false,reason:'gap'}};text=appended;
    }
    const body={text,overlayV1:metadata};
    const event=helperOverlayEvent(body);
    if(!event||Buffer.byteLength(JSON.stringify(event))+256>HELPER_OVERLAY_MAX_FRAME_BYTES)return {ack:{accepted:false,reason:'unavailable'}};
    await tx.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
      [frame.roomId,frame.agentId,frame.turnId,frame.kind,JSON.stringify(body)]);
    return {ack:{accepted:true,revision:frame.revision},event:helperOverlayEvent(body)};
  });}catch{return {ack:{accepted:false,reason:'unavailable'}};}
}
/** Last authority check and synchronous transport enqueue share the fence.
 * Terminal DB state always wins over late stored baselines/append notifications. */
export async function fenceHelperOverlayEnqueue(db:SqlDatabase,event:LiveEvent,enqueue:()=>void,readerId?:string):Promise<void>{
  const metadata=helperOverlayMetadata((event as unknown as Record<string,unknown>).overlayV1);
  if(!metadata){enqueue();return;}
  if(Buffer.byteLength(JSON.stringify(event))+256>HELPER_OVERLAY_MAX_FRAME_BYTES)return;
  try{await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
    if(!readerId||!await currentOwner(tx,metadata))return;
    if(!(await tx.query(`SELECT 1 FROM room_access access JOIN rooms room ON room.id=access.room_id
      JOIN memberships workspace ON workspace.workspace_id=room.workspace_id AND workspace.identity_id=access.identity_id
        AND workspace.room_id IS NULL AND workspace.removed_at IS NULL
      WHERE access.room_id=$1 AND access.identity_id=$2 AND access.removed_at IS NULL AND room.archived_at IS NULL`,
      [metadata.roomId,readerId])).rowCount)return;
    const latest=(await tx.query<{body:Record<string,unknown>}>(`SELECT body FROM live_outputs
      WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind=$4`,
      [metadata.roomId,metadata.agentId,metadata.turnId,metadata.kind])).rows[0]?.body;
    const current=helperOverlayMetadata(latest?.overlayV1);
    if(!current||current.runGeneration!==metadata.runGeneration||current.revision<metadata.revision||
      ((current.type==='end'||current.type==='retract')&&metadata.type!=='end'&&metadata.type!=='retract'))return;
    enqueue();
  });}catch{/* A stale/unavailable overlay stays hidden. */}
}

/** Each phone viewing lifetime starts behind a fresh-helper baseline barrier.
 * The bounded pre-commit slot closes baseline-before-view-write-return races. */
type OverlayViewingRoom={revision?:number;lanes:Map<string,HelperOverlayMetadata>;admitted:Map<string,HelperOverlayMetadata>;pending:Map<string,HelperOverlayLiveEvent>};
export class HelperOverlayViewer {
  private readonly rooms=new Map<string,OverlayViewingRoom>();
  constructor(private readonly enqueue:(event:HelperOverlayLiveEvent)=>void){}
  private lane(metadata:HelperOverlayMetadata):string{return metadata.agentId+':'+metadata.kind;}
  private pendingLane(metadata:HelperOverlayMetadata):string{return JSON.stringify([this.lane(metadata),metadata.commandId,metadata.turnGeneration,metadata.runGeneration,metadata.viewingRevision]);}
  private buffer(room:OverlayViewingRoom,event:HelperOverlayLiveEvent):void{
    const key=this.pendingLane(event.overlayV1),old=room.pending.get(key);
    if(old&&old.overlayV1.revision>=event.overlayV1.revision)return;
    if(!old&&room.pending.size>=256)return;
    const bytes=(value:HelperOverlayLiveEvent)=>'text'in value?Buffer.byteLength(value.text):0;
    const total=[...room.pending.values()].reduce((sum,value)=>sum+bytes(value),0)-(old?bytes(old):0)+bytes(event);
    if(total>1024*1024)return;
    room.pending.set(key,event);
  }
  enter(roomId:string):void{
    if(this.rooms.has(roomId))return;
    if(this.rooms.size>=32)throw new Error('Overlay viewing capacity exceeded');
    this.rooms.set(roomId,{lanes:new Map(),admitted:new Map(),pending:new Map()});
  }
  commit(roomId:string,viewingRevision:number):void{
    const room=this.rooms.get(roomId);if(!room)return;room.revision=viewingRevision;
    for(const [key,pending]of [...room.pending]){
      if(pending.overlayV1.type!=='baseline')continue;
      room.pending.delete(key);if(this.accept(pending))this.enqueue(pending);
    }
  }
  leave(roomId:string):void{this.rooms.delete(roomId);}
  clear():void{this.rooms.clear();}
  /** Canonical full value is present even when LISTEN coalesced revisions. */
  normalize(event:LiveEvent):LiveEvent{
    const metadata=helperOverlayMetadata((event as unknown as Record<string,unknown>).overlayV1);
    if(!metadata||metadata.type!=='append')return event;
    const old=this.rooms.get(metadata.roomId)?.lanes.get(this.lane(metadata));
    if(old?.revision===metadata.revision-1&&old.runGeneration===metadata.runGeneration&&old.commandId===metadata.commandId)return event;
    return {...event,overlayV1:{...metadata,type:'replace',offset:0}} as LiveEvent;
  }
  /** Recheck inside the successful enqueue: another async fence may already
   * have delivered a newer frame while this one waited for its DB lock. */
  canDeliver(event:LiveEvent):boolean{
    const metadata=helperOverlayMetadata((event as unknown as Record<string,unknown>).overlayV1);
    if(!metadata)return false;
    const room=this.rooms.get(metadata.roomId);if(!room||room.revision===undefined||metadata.viewingRevision<room.revision)return false;
    const old=room.lanes.get(this.lane(metadata));
    const same=old?.commandId===metadata.commandId&&old.turnGeneration===metadata.turnGeneration;
    if(same&&(metadata.runGeneration<old.runGeneration||metadata.revision<=old.revision||old.type==='end'||old.type==='retract'))return false;
    if(metadata.type!=='baseline'&&(!same||old?.runGeneration!==metadata.runGeneration||old.viewingRevision!==metadata.viewingRevision))return false;
    return room.lanes.has(this.lane(metadata))||room.lanes.size<256;
  }
  /** Runs only after synchronous client.send accepted this exact frame. */
  delivered(event:LiveEvent):void{
    if(!this.canDeliver(event))return;
    const metadata=helperOverlayMetadata((event as unknown as Record<string,unknown>).overlayV1)!;
    const room=this.rooms.get(metadata.roomId)!;room.lanes.set(this.lane(metadata),metadata);
    const key=this.pendingLane(metadata);room.admitted.delete(key);
    const next=room.pending.get(key);room.pending.delete(key);
    if(next&&next.overlayV1.revision>metadata.revision)queueMicrotask(()=>{
      if(this.accept(next))this.enqueue(next);
    });
  }
  accept(event:LiveEvent):boolean{
    const metadata=helperOverlayMetadata((event as unknown as Record<string,unknown>).overlayV1);
    if(!metadata)return false;
    const room=this.rooms.get(metadata.roomId);if(!room)return false;
    const key=this.pendingLane(metadata);
    if(room.revision===undefined){
      const previous=room.pending.get(key);
      if(metadata.type==='baseline')this.buffer(room,event as HelperOverlayLiveEvent);
      else if(previous?.overlayV1.type==='baseline'&&metadata.revision>previous.overlayV1.revision){
        // Retain the observed fresh-baseline barrier while coalescing its
        // subsequent full canonical value before viewing commit returns.
        this.buffer(room,{...event,overlayV1:{...metadata,type:'baseline',offset:0}} as HelperOverlayLiveEvent);
      }
      return false;
    }
    if(this.canDeliver(event)){
      if(metadata.type==='baseline'){
        if(!room.admitted.has(key)&&room.admitted.size>=256)return false;
        room.admitted.set(key,metadata);
      }
      return true;
    }
    const baseline=room.admitted.get(key);
    if(baseline&&metadata.revision>baseline.revision)this.buffer(room,event as HelperOverlayLiveEvent);
    return false;
  }
}
