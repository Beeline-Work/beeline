import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { callAgentTool } from './read-only-mcp.js';
let scratch:string;
beforeEach(async()=>{
  scratch=await mkdtemp(join(tmpdir(),'beeline-result-context-'));
  const path=join(scratch,'turn.json');
  await writeFile(path,JSON.stringify({roomId:'room',requestId:'first',generationId:'generation',commandReason:'order',
    commands:[{requestId:'first',commandReason:'order'},{requestId:'second',commandReason:'report'}]}));
  vi.stubEnv('BEELINE_TURN_CONTEXT_FILE',path);
  vi.stubEnv('BEELINE_DAEMON_BASE_URL','http://127.0.0.1:1');
  vi.stubEnv('BEELINE_DAEMON_TOKEN','test-token');
});
afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await rm(scratch,{recursive:true,force:true});});
it('concurrent reports carry their own claimed requestId and the common execution generation',async()=>{
  const inputs:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:RequestInit)=>{
    inputs.push(JSON.parse(String(init.body)));return new Response(JSON.stringify({id:'result',createdAt:1}),{status:200});
  }));
  await Promise.all(['first','second'].map(requestId=>callAgentTool('report',{requestId,status:'done',text:'Completed'},requestId)));
  expect(inputs.map(input=>input.requestId).sort()).toEqual(['first','second']);
  expect(inputs.every(input=>input.roomId==='room'&&input.generationId==='generation')).toBe(true);
});
it('refuses a request outside the claimed group before making a network request',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(callAgentTool('report',{requestId:'unclaimed',status:'done',text:'Completed'},'call')).rejects.toThrow('no active server command');
  expect(fetch).not.toHaveBeenCalled();
});

it('work tools can serve another claimed request after the first answer',async()=>{
  const inputs:Record<string,unknown>[]=[];
  vi.stubEnv('BEELINE_DAEMON_ROOM_ID','room');
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:RequestInit)=>{
    inputs.push(JSON.parse(String(init.body)));return new Response(JSON.stringify({id:'result',createdAt:1}),{status:200});
  }));
  await callAgentTool('report',{requestId:'first',status:'done',text:'Completed first'},'first-answer');
  await callAgentTool('order',{requestId:'second',address:'11111111-1111-4111-8111-111111111111',agent:'worker',text:'Please implement the second request'},'second-work');
  expect(inputs.map(input=>input.requestId)).toEqual(['first','second']);
  expect(inputs[1]).toMatchObject({generationId:'generation',agent:'worker',text:'Please implement the second request'});
});
