import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { expect,it,vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import { DurableLiveReplay } from './durable-live.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';
import { createBeelineServer } from './server.js';
import { migratedDatabase } from './test-support.js';
const VIEWER='a'.repeat(64),OTHER='b'.repeat(64);
const WORKSPACE='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222';

it('negotiates before subscribe and projects one source through canonical builders without legacy durable DTO reads',async()=>{
  const db=await migratedDatabase(),live=new LiveHub(),phone=new PhoneService(db,'https://example.test');
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Other','other')`,[VIEWER,OTHER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WORKSPACE,VIEWER]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$4,'member')`,[WORKSPACE,ROOM,VIEWER,OTHER]);
  const builds=vi.spyOn(phone,'buildRouterValue'),delta=vi.spyOn(phone,'readLiveDeltas'),committed=vi.spyOn(phone,'projectCommittedLiveDelta');
  const needs=vi.spyOn(phone,'liveNeedsYou'),readState=vi.spyOn(phone,'liveReadState'),commands=vi.spyOn(phone,'liveRoomCommands');
  const unlisten=await db.client.listen(POSTGRES_LIVE_CHANNEL,raw=>{
    const source=JSON.parse(raw);if(source.journalStreams)live.journalChanged(source.journalStreams);
    if(source.table==='messages')live.publish({type:'invalidate',roomId:source.roomId,reason:'postgres:messages',messageId:source.messageId,agentId:source.agentId,needsYouCandidate:source.needsYouCandidate});
  });
  const server=createBeelineServer({database:db,live,phone,replay:new DurableLiveReplay(db,live),
    routerProjections:{families:['room-list','needs-you','needs-you-count','room-head'],listenerReady:()=>true},
    auth:{authenticatePhone:async()=>VIEWER} as unknown as TokenAuth,daemon:{} as DaemonService,mediaMaximumBytes:1});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/live`,['bearer.fixture']);
  const frames:Record<string,any>[]=[];const waiters=new Set<()=>void>();
  socket.on('message',raw=>{frames.push(JSON.parse(raw.toString()));for(const wake of waiters)wake();});
  const wait=(predicate:()=>boolean)=>new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{waiters.delete(check);reject(new Error('projection frame deadline'));},10_000);
    const check=()=>{if(predicate()){clearTimeout(timer);waiters.delete(check);resolve();}};waiters.add(check);check();
  });
  try{
    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    socket.send(JSON.stringify({type:'router-negotiate',protocol:1,families:['room-list','needs-you','needs-you-count','room-head']}));
    socket.send(JSON.stringify({type:'subscribe',roomId:ROOM,sidebarPreviews:true,roomStateProjections:true}));
    await wait(()=>frames.some(f=>f.type==='subscribed'));
    expect(frames.findIndex(f=>f.type==='router-capabilities')).toBeLessThan(frames.findIndex(f=>f.type==='subscribed'));
    builds.mockClear();delta.mockClear();committed.mockClear();needs.mockClear();readState.mockClear();commands.mockClear();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@reader please approve?')`,['c'.repeat(64),ROOM,OTHER]);
    await wait(()=>frames.some(f=>f.kind==='push-commit'));
    expect(builds.mock.calls.map(([,input])=>input.family).sort()).toEqual(['needs-you','needs-you-count','room-head','room-list']);
    expect(delta).not.toHaveBeenCalled();expect(committed).not.toHaveBeenCalled();expect(needs).not.toHaveBeenCalled();
    expect(readState).not.toHaveBeenCalled();expect(commands).not.toHaveBeenCalled();
    expect(frames.filter(f=>['message-delta','turn-delta','read-state','room-commands','sidebar-preview','needs-you-delta'].includes(f.type))).toEqual([]);
  }finally{
    socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));await unlisten();await db.close();
  }
},30_000);
