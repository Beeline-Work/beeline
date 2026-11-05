import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync } from 'node:fs';
import path from 'node:path';
import { inspectMachineConnectionSource,machineConnectionSites,judgeMachineSites,checkMachineConnections } from './machine-connection-boundaries.mjs';

test('new helper timers fail, including aliases, promises, native deadlines, and generated child code',()=>{
  for(const source of [
    'setTimeout(tick,1)','setInterval(tick,1)','globalThis["setTimeout"](tick,1)',
    'const later=setTimeout;later(tick,1)','socket.setTimeout(1,tick)',
    'import {setTimeout as pause} from "node:timers/promises";await pause(1)',
    'await import("node:timers/promises").then(timers=>timers.setTimeout(1))',
    'await AbortSignal.timeout(1)','setImmediate(function again(){setImmediate(again)})',
    'export const child=`setInterval(tick,1)`',
  ])assert.ok(inspectMachineConnectionSource('apps/body/src/planted.ts',source).some(error=>error.includes('timer')),source);
  assert.deepEqual(inspectMachineConnectionSource('apps/body/src/event-owner.ts','socket.once("close",onClose)'),[]);
});

test('a second machine connection trigger cannot hide behind aliases or the trusted owner file',()=>{
  for(const source of [
    'api.link.reconnectNow()','const reconnect=machine.link.reconnectNow;reconnect()',
    'const {send}=api.link;send(frame)','api.link["terminate"]()',
    'import {LiveLink as Other} from "./live-link.js";new Other(options)',
    'new WebSocket("wss://example.test/v1/phone/live")',
  ])assert.ok(inspectMachineConnectionSource('apps/body/src/planted.ts',source).length,source);
  assert.ok(inspectMachineConnectionSource('apps/body/src/live-link.ts','class LiveLink { extra(){this.#connect()} }').length);
  const sites=machineConnectionSites('apps/body/src/live-link.ts','class LiveLink { extra(){this.#socket.send(frame)} }');
  assert.ok(judgeMachineSites(sites,{}).length);
});

test('registration failures and request failures cannot evict a server machine',()=>{
  assert.ok(inspectMachineConnectionSource('apps/server/src/daemon-live.ts','class DaemonAgentSession { failed(){this.evict("read failed")} }').length);
});

test('sink inventory may only shrink',()=>{
  const id='apps/body/src/live-link.ts::send::send';
  assert.ok(judgeMachineSites(new Map([[id,2]]),{[id]:{count:2,reason:'new'}},{[id]:{count:1,reason:'old'}}).length);
});

test('the real tree checker rejects a planted second reconnect and timer',()=>{
  const root=mkdtempSync(path.join(process.cwd(),'.machine-guard-'));
  try{
    mkdirSync(path.join(root,'apps/body/src'),{recursive:true});mkdirSync(path.join(root,'architecture'));
    writeFileSync(path.join(root,'architecture/machine-connection-sinks.json'),'{}');
    writeFileSync(path.join(root,'apps/body/src/planted.ts'),'export const innocent=true;');
    assert.deepEqual(checkMachineConnections(root),[]);
    writeFileSync(path.join(root,'apps/body/src/planted.ts'),'export function secondConnection(api){api.link.reconnectNow();setTimeout(()=>api.link.reconnectNow(),1)}');
    const errors=checkMachineConnections(root);
    assert.ok(errors.some(error=>error.includes('timer')));assert.ok(errors.some(error=>error.includes('reconnect')));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('the sole warm countdown is pinned to AgentProcesses.workChanged',()=>{
  const file='apps/body/src/agent-process.ts';
  assert.deepEqual(inspectMachineConnectionSource(file,'class AgentProcesses { workChanged(){setTimeout(stop,60000)} }'),[]);
  assert.ok(inspectMachineConnectionSource(file,'class AgentProcesses { workChanged(){setTimeout(stop,60000);setTimeout(other,10)} }').length);
  assert.ok(inspectMachineConnectionSource(file,'class AgentProcesses { extra(){setTimeout(stop,60000)} }').length);
});
