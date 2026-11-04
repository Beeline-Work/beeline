import {createHash} from 'node:crypto';
import {once} from 'node:events';
import type {Socket} from 'node:net';
import {performance} from 'node:perf_hooks';
import {WebSocket,WebSocketServer} from 'ws';
import {describe,expect,it} from 'vitest';
import type {ScheduledWorkResult} from '@beeline/api-contract/phone';
import {PHONE_SOCKET_MAX_FRAME_BYTES} from '@beeline/api-contract/phone';
import type {RouterCapabilities,RouterSnapshot,ScheduledWorkAuthorityPosition} from '@beeline/api-contract/router-protocol';
import {encodeRouterBatch,routerAuthority} from './router-projections.js';
import {encodeScheduledWorkAuthority} from './scheduled-work-authority-delivery.js';

const VIEWER='a'.repeat(64),AGENT='b'.repeat(64),WS='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222';
const originHash=(label:string)=>createHash('sha256').update(`synthetic-only:${label}`).digest('hex');
const json=(value:unknown)=>JSON.stringify(value);
const bytes=(value:string)=>Buffer.byteLength(value);
const REPEATS=4;
type Cohort='public-manager'|'own-DM';
type Mode='legacy-scheduled-read'|'compact-scheduled-router';
type Direction='clientToServer'|'serverToClient';
type Phase='negotiation'|'cold'|'authority'|'source';
type Counters={clientToServer:number;serverToClient:number};
type Fixture={cohort:Cohort;rows:number;before:ScheduledWorkResult;after:ScheduledWorkResult;
  snapshot:RouterSnapshot<'room-scheduled-work'>;start:ScheduledWorkAuthorityPosition;next:ScheduledWorkAuthorityPosition;
  authority:ReturnType<typeof routerAuthority>;commonFence:Record<string,unknown>;
  sourceFrames:ReturnType<typeof encodeRouterBatch>;controlFrames:ReturnType<typeof encodeScheduledWorkAuthority>};
const fixture=(cohort:Cohort,rows:number):Fixture=>{
  const scheduleAt=(index:number):ScheduledWorkResult['schedules'][number]=>({
    id:`33333333-3333-4333-8333-${String(index+1).padStart(12,'0')}`,workspaceId:WS,roomId:ROOM,agentId:AGENT,creatorId:VIEWER,
    title:`Synthetic task ${index+1}`,cadence:{kind:'interval',everyMinutes:10},
    message:`Synthetic task ${index+1}. ${originHash(`prompt:${index}`)}. `+
      'Read the stored synthetic example and report its exact state. '.repeat(rows>1?4:1),
    nextRunAt:4070908800,createdAt:1767225600,runCount:0,
  });
  const schedules:ScheduledWorkResult['schedules']=Array.from({length:rows},(_,index)=>scheduleAt(index));
  const before:ScheduledWorkResult={roomName:'Synthetic scope',isDirectMessage:cohort==='own-DM',agentNames:[[AGENT,'Synthetic helper']],schedules,subscriptions:[]};
  // Empty surfaces receive one inserted schedule; populated surfaces change
  // one complete schedule, with every other display field identical.
  const after:ScheduledWorkResult=rows?{...before,schedules:schedules.map((row,index)=>index?row:{...row,runCount:1})}:{...before,schedules:[scheduleAt(0)]};
  const access=cohort==='own-DM'?`scheduled-work-member:${VIEWER}:room:${ROOM}`:`scheduled-work-manager:${VIEWER}:workspace:${WS}`;
  const authority=routerAuthority([{authorityScope:`scheduled-work-principal:${VIEWER}`,epoch:'7'},
    {authorityScope:access,epoch:'7'},{authorityScope:`scheduled-work-room:${ROOM}`,epoch:'7'}]);
  const start:ScheduledWorkAuthorityPosition={stream:`authority:${VIEWER}`,epoch:originHash('authority').slice(0,32),
    segment:'44444444-4444-4444-8444-444444444444',through:10,protocol:1};
  const next={...start,through:11};
  const domain=`reader:${VIEWER}:workspace:${WS}:visibility`;
  const snapshot:RouterSnapshot<'room-scheduled-work'>={kind:'snapshot',family:'room-scheduled-work',scope:ROOM,value:before,
      cut:{stream:`workspace:${WS}`,epoch:originHash('workspace').slice(0,32),through:20,protocol:1},
      atomicGroup:`room-scheduled-work:${ROOM}:${VIEWER}`,authority};
  return {cohort,rows,before,after,authority,start,next,snapshot,
    // Generate random transport batch IDs once. Both compression policies then
    // transfer byte-for-byte identical serialized application messages.
    sourceFrames:encodeRouterBatch(snapshot.cut,{...snapshot.cut,through:22},[{atomicGroup:snapshot.atomicGroup,authority,
      payload:{kind:'scope-replace',family:'room-scheduled-work',scope:ROOM,value:after}},
      {kind:'scheduled-work-classification',version:1,authorityBarrier:next}]),
    controlFrames:encodeScheduledWorkAuthority(start,next,[]),
    commonFence:{kind:'authority-fence',scope:WS,authorityScope:domain,mode:'advance',authority:routerAuthority([{authorityScope:domain,epoch:'8'}])}};
};

function plus(a:Counters,b:Counters):Counters{return {clientToServer:a.clientToServer+b.clientToServer,serverToClient:a.serverToClient+b.serverToClient};}
function difference(a:Counters,b:Counters):Counters{return {clientToServer:a.clientToServer-b.clientToServer,serverToClient:a.serverToClient-b.serverToClient};}
function sum(a:Counters){return a.clientToServer+a.serverToClient;}
const empty=():Counters=>({clientToServer:0,serverToClient:0});
const frameBytes=(length:number,masked:boolean)=>length+2+(length<126?0:length<=65535?2:8)+(masked?4:0);

/** Plain loopback TCP: physical WebSocket bytes include frame headers, masking
 * and compressed payload, but exclude TLS/IP/radio and all production DB work.
 * Both ends negotiate the same no-context, threshold-zero policy. The public
 * upgrade response/request sockets expose counters; no private ws field or
 * reimplementation of its compressor supplies a measurement. */
async function measure(data:Fixture,mode:Mode,compression:boolean){
  const compressionPolicy=compression?{threshold:0,clientNoContextTakeover:true,serverNoContextTakeover:true,
    concurrencyLimit:1,zlibDeflateOptions:{level:6}}:false;
  const server=new WebSocketServer({host:'127.0.0.1',port:0,perMessageDeflate:compressionPolicy,maxPayload:PHONE_SOCKET_MAX_FRAME_BYTES});
  let client:WebSocket|undefined,peer:WebSocket|undefined,serverSocket:Socket|undefined,clientSocket:Socket|undefined;
  let closed=false;
  try{
    await once(server,'listening');
    const address=server.address();if(!address||typeof address==='string')throw new Error('Missing isolated loopback listener');
    const connected=once(server,'connection');
    client=new WebSocket(`ws://127.0.0.1:${address.port}`,{perMessageDeflate:compressionPolicy,maxPayload:PHONE_SOCKET_MAX_FRAME_BYTES});
    client.once('upgrade',response=>{clientSocket=response.socket;});
    const [accepted]=await Promise.all([connected,once(client,'open')]);
    peer=accepted[0] as WebSocket;serverSocket=accepted[1].socket as Socket;
    if(!clientSocket||!serverSocket)throw new Error('Missing physical counter sockets');
    expect(client.extensions).toBe(compression?'permessage-deflate':'');expect(peer.extensions).toBe(client.extensions);
    const counters=():Counters=>({clientToServer:serverSocket!.bytesRead,serverToClient:clientSocket!.bytesRead});
    const handshake=counters();
    expect(handshake.clientToServer).toBe(clientSocket.bytesWritten);expect(handshake.serverToClient).toBe(serverSocket.bytesWritten);
    const decoded:{phase:Phase;direction:Direction;value:unknown}[]=[],plain:{phase:Phase;direction:Direction;wire:string}[]=[];
    const phases:Record<Phase,{physical:Counters;json:Counters;frames:Counters}>={negotiation:{physical:empty(),json:empty(),frames:empty()},
      cold:{physical:empty(),json:empty(),frames:empty()},authority:{physical:empty(),json:empty(),frames:empty()},source:{physical:empty(),json:empty(),frames:empty()}};
    async function transfer(phase:Phase,direction:Direction,value:unknown){
      const wire=json(value);expect(bytes(wire)).toBeLessThanOrEqual(PHONE_SOCKET_MAX_FRAME_BYTES);
      const sender=direction==='clientToServer'?client!:peer!,receiver=direction==='clientToServer'?peer!:client!;
      const before=counters(),received=once(receiver,'message');
      const sent=new Promise<void>((resolve,reject)=>{sender.send(wire,{compress:compression},error=>{if(error)reject(error);else resolve();});});
      const [message]=await Promise.all([received,sent]);
      expect(message[1]).toBe(false);expect(message[0].toString()).toBe(wire);
      decoded.push({phase,direction,value:JSON.parse(message[0].toString())});plain.push({phase,direction,wire});
      const delta=difference(counters(),before);
      expect(delta[direction]).toBeGreaterThan(0);expect(delta[direction==='clientToServer'?'serverToClient':'clientToServer']).toBe(0);
      if(!compression)expect(delta[direction]).toBe(frameBytes(bytes(wire),direction==='clientToServer'));
      phases[phase].physical=plus(phases[phase].physical,delta);phases[phase].json[direction]+=bytes(wire);phases[phase].frames[direction]++;
    }
    // Same capable phone and common main-socket authority consumer; only
    // Scheduled Work support differs. This models no native/old-binary floor.
    const negotiate={type:'router-negotiate',protocol:1,families:['needs-you-count','room-scheduled-work'],authorityFencesV1:true,scheduledWorkCoverageV1:true};
    const capability:RouterCapabilities={protocol:1,families:mode==='legacy-scheduled-read'?['needs-you-count']:['needs-you-count','room-scheduled-work'],
      commandDedupV1:true,mediaMetadataV1:false,authorityFencesV1:true,
      ...(mode==='compact-scheduled-router'?{scheduledWorkCoverageV1:{version:1,authorityStart:data.start}}:{})};
    await transfer('negotiation','clientToServer',negotiate);await transfer('negotiation','serverToClient',{type:'router-capabilities',...capability});
    const cpu=process.cpuUsage(),started=performance.now();
    for(let repeat=0;repeat<REPEATS;repeat++){
      const id=`phone-${repeat*2+1}`;
      await transfer('cold','clientToServer',{t:'req',id,op:mode==='legacy-scheduled-read'?'readScheduledWork':'readRouterSnapshot',
        args:mode==='legacy-scheduled-read'?{roomId:ROOM}:{family:'room-scheduled-work',roomId:ROOM}});
      await transfer('cold','serverToClient',{t:'res',id,ok:true,result:mode==='legacy-scheduled-read'?data.before:{...data.snapshot,authorityBarrier:data.start}});
      // A shared visibility-domain floor changes neither the manager nor own-DM
      // certificate. The compact actor must also commit its complete authority
      // interval, even though that interval has zero Scheduled Work fences.
      await transfer('authority','serverToClient',data.commonFence);
      if(mode==='compact-scheduled-router')for(const frame of data.controlFrames)await transfer('authority','serverToClient',frame);
      if(mode==='legacy-scheduled-read'){
        await transfer('source','serverToClient',{type:'invalidate',roomId:ROOM,reason:'postgres:agent_schedules',operation:data.rows?'UPDATE':'INSERT',agentId:AGENT,
          trace:{id:originHash('trace').slice(0,32),databaseAt:1767225600000,emittedAt:1767225600000}});
        await transfer('source','clientToServer',{t:'req',id:`phone-${repeat*2+2}`,op:'readScheduledWork',args:{roomId:ROOM}});
        await transfer('source','serverToClient',{t:'res',id:`phone-${repeat*2+2}`,ok:true,result:data.after});
      }else{
        for(const frame of data.sourceFrames)await transfer('source','serverToClient',frame);
      }
    }
    const elapsedMs=performance.now()-started,usage=process.cpuUsage(cpu),app=difference(counters(),handshake);
    expect(app).toEqual(Object.values(phases).reduce((total,phase)=>plus(total,phase.physical),empty()));
    expect(serverSocket.bytesWritten).toBe(clientSocket.bytesRead);expect(clientSocket.bytesWritten).toBe(serverSocket.bytesRead);
    // Teardown is separately accounted, never hidden inside application bytes.
    const beforeClose=counters(),clientClose=once(client,'close'),peerClose=once(peer,'close');client.close(1000);
    await Promise.all([clientClose,peerClose]);const teardown=difference(counters(),beforeClose);
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));closed=true;
    return {compression,mode,handshake,phases,application:app,teardown,total:plus(plus(handshake,app),teardown),
      cpu:{userUs:usage.user,systemUs:usage.system,elapsedMs,repeats:REPEATS},decoded,plain};
  }finally{
    client?.terminate();peer?.terminate();
    if(!closed)await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
}

describe('synthetic loopback WebSocket Scheduled Work compression accounting',()=>{
  it.each((['public-manager','own-DM'] as const).flatMap(cohort=>[0,1,50].map(rows=>({cohort,rows}))))(
    'records both identical transport policies for $cohort / $rows schedule rows without predicting a budget pass',async({cohort,rows})=>{
      const data=fixture(cohort,rows),results=[];
      for(const compression of [false,true])for(const mode of ['legacy-scheduled-read','compact-scheduled-router'] as const)results.push(await measure(data,mode,compression));
      for(const mode of ['legacy-scheduled-read','compact-scheduled-router'] as const){
        const off=results.find(result=>result.mode===mode&&!result.compression)!,on=results.find(result=>result.mode===mode&&result.compression)!;
        expect(on.decoded).toEqual(off.decoded);expect(on.plain).toEqual(off.plain);
        for(const phase of ['negotiation','cold','authority','source'] as const){
          expect(on.phases[phase].json).toEqual(off.phases[phase].json);expect(on.phases[phase].frames).toEqual(off.phases[phase].frames);
        }
        expect(on.handshake.clientToServer).toBeGreaterThan(off.handshake.clientToServer);
        expect(on.handshake.serverToClient).toBeGreaterThan(off.handshake.serverToClient);
        // Compression can expand a short frame. No compressed<=plain or
        // candidate<=legacy assertion is invented; both observed ratios print.
      }
      for(const result of results){
        const coldReplies=result.decoded.filter(frame=>frame.phase==='cold'&&frame.direction==='serverToClient').map(frame=>(frame.value as any).result);
        for(const reply of coldReplies)expect(result.mode==='legacy-scheduled-read'?reply:reply.value).toEqual(data.before);
        const updated=result.decoded.filter(frame=>frame.phase==='source'&&frame.direction==='serverToClient').flatMap(frame=>{
          const value=frame.value as any;return value.t==='res'?[value.result]:value.kind==='push-part'?value.facts.filter((fact:any)=>fact.payload?.kind==='scope-replace').map((fact:any)=>fact.payload.value):[];
        });
        expect(updated).toHaveLength(REPEATS);for(const value of updated)expect(value).toEqual(data.after);
        const controls=result.decoded.filter(frame=>frame.phase==='authority');
        expect(controls).toHaveLength(REPEATS*(result.mode==='legacy-scheduled-read'?1:3));
      }
      const report=results.map(({decoded,plain,...result})=>({...result,
        applicationBytes:sum(result.application),physicalPerRepeatedSample:(sum(result.application)-sum(result.phases.negotiation.physical))/REPEATS}));
      const comparisons=[false,true].map(compression=>{const legacy=report.find(result=>result.compression===compression&&result.mode==='legacy-scheduled-read')!,
        candidate=report.find(result=>result.compression===compression&&result.mode==='compact-scheduled-router')!;
        return {compression,applicationByteRatio:candidate.applicationBytes/legacy.applicationBytes,
          totalPhysicalByteRatio:sum(candidate.total)/sum(legacy.total),
          phasePhysicalByteRatios:Object.fromEntries((['negotiation','cold','authority','source'] as const)
            .map(phase=>[phase,sum(candidate.phases[phase].physical)/sum(legacy.phases[phase].physical)])),
          cpuUserRatio:legacy.cpu.userUs?candidate.cpu.userUs/legacy.cpu.userUs:null};});
      console.log('SCHEDULED_WORK_COMPRESSION_SYNTHETIC',json({cohort,scheduleRows:rows,resultBytes:bytes(json(data.before)),report,comparisons,
        policy:{threshold:0,clientNoContextTakeover:true,serverNoContextTakeover:true,deflateLevel:6,compressionConcurrency:1},
        limits:'Synthetic plain loopback TCP only. Actual closed serializers/wrappers/barriers; repeated fixed-fixture exchanges are transport samples, not a coherent production DB journey. CPU is process-wide approximate (assertions/GC/JSON and both peers included), not p95 or a performance pass. No TLS/radio, DB/source/fence/build CPU, native40/web/helper or activation claim. Physical bytes count all sent messages, handshake and teardown separately; no certificate omission.'}));
    },15000);
});
