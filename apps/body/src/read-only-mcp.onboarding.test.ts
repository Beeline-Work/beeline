import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { callAgentTool } from './read-only-mcp.js';
import { CommandExecutionContext } from './server-command-intake.js';
const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
let context: CommandExecutionContext;
beforeEach(async () => {
  calls.length=0;
  context=new CommandExecutionContext(mkdtempSync(join(tmpdir(),'onboarding-tools-')));
  await context.enter({roomId:'room-1',turnRequestId:'request-1',rootCommandId:'command-1'} as AgentCommand);
  for (const [key,value] of Object.entries({BEELINE_DAEMON_AGENT_ID:'agent-1',BEELINE_DAEMON_ROOM_ID:'room-1',BEELINE_DAEMON_BASE_URL:'http://localhost:1234',BEELINE_DAEMON_TOKEN:'test-token',BEELINE_TURN_CONTEXT_FILE:context.path})) vi.stubEnv(key,value);
  vi.stubGlobal('fetch', async (url:URL,init:RequestInit) => {
    calls.push({name:new URL(url).pathname.split('/').pop()!,input:JSON.parse(String(init.body))});
    return Response.json({state:'no_repo_linked',repositoryOnboarding:true});
  });
});
afterEach(() => {vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('discovers cards and Room invitations without an external connection and binds writes to the active turn',async()=>{
  const discovered=JSON.parse(await callAgentTool('app_tool',{app:'beeline:onboarding'},'discover'));
  expect(discovered.tools.map((t:{name:string})=>t.name)).toEqual(expect.arrayContaining(['welcome','video_preview','invite','repository','starters']));
  calls.length = 0;
  await callAgentTool('app_tool',{app:'beeline:onboarding',tool:'welcome',args:{}});
  expect(calls.find(call => call.name === 'postStarterWelcome')!.input).toMatchObject({roomId:'room-1',requestId:'request-1',taskId:'command-1',generationId:context.generationId});
  for (const tool of ['repository','starters']) await callAgentTool('app_tool',{app:'beeline:onboarding',tool,args:{}});
  expect(calls.filter(call=>call.name === 'postRepositoryOnboarding').map(call=>call.name)).toEqual(['postRepositoryOnboarding','postRepositoryOnboarding']);
  expect(calls.filter(call=>call.name === 'postRepositoryOnboarding').map(call=>call.input.kind)).toEqual(['repository','starters']);
  expect(calls.find(call=>call.name === 'postRepositoryOnboarding')!.input).toMatchObject({roomId:'room-1',requestId:'request-1',generationId:context.generationId});
  await callAgentTool('app_tool',{app:'beeline:onboarding',tool:'invite',args:{}});
  expect(calls.filter(call=>call.name === 'postRoomInvite')).toEqual([{
    name:'postRoomInvite', input:{roomId:'room-1',requestId:'request-1',taskId:'command-1',generationId:context.generationId},
  }]);
});

it('hides the new tools when server eligibility is absent', async () => {
  vi.stubGlobal('fetch', async () => Response.json({resolution:'none'}));
  await expect(callAgentTool('app_tool',{app:'beeline:onboarding'},'discover')).rejects.toThrow('unavailable');
  const discovered = JSON.parse(await callAgentTool('connect',{mode:'discover'},'discover'));
  expect(discovered.capabilities).not.toContain('beeline:onboarding');
});

it.each(['GitHub', 'link my repository', 'connect my repo', 'GitHub repository'])('R-REPO-CARD: routes %s to the repository card before connector search', async service => {
  const result = JSON.parse(await callAgentTool('connect', {mode:'ensure', service, reason:`Connect ${service}`, continuation:`Connect my ${service} account.`}, 'repo-connect'));
  expect(result).toMatchObject({status:'ready', app:'beeline:onboarding'});
  await callAgentTool('app_tool', {app:result.app, tool:'repository', args:{}}, 'repo-card');
  expect(calls.some(call => call.name === 'postRepositoryOnboarding')).toBe(true);
  expect(calls.some(call => ['connect','find_connectors'].includes(call.name))).toBe(false);
});
it('advertises repository onboarding without an exact-name query', async () => {
  const result = JSON.parse(await callAgentTool('connect', {mode:'discover'}, 'discover'));
  expect(result.capabilities).toContain('beeline:onboarding');
});

it('reports unavailable repo cards without attempting an external connector', async () => {
  vi.stubGlobal('fetch', async (url: URL) => {
    calls.push({name:new URL(url).pathname.split('/').pop()!,input:{}});
    return Response.json({repositoryOnboarding:false});
  });
  const result = JSON.parse(await callAgentTool('connect', {mode:'ensure',service:'link my repository',reason:'Connect the repository',continuation:'Show the repository card.'}, 'connect'));
  expect(result).toMatchObject({status:'unavailable',app:'beeline:onboarding'});
  expect(result.next).toContain('active Room');
  expect(calls.map(call => call.name)).toEqual(['getRoomRepositoryState']);
});

it('keeps ordinary GitHub repository reads on the connector route', async () => {
  await callAgentTool('connect', {mode:'ensure', service:'GitHub', reason:'List repositories', continuation:'Read the account repositories.'}, 'github');
  expect(calls.map(call => call.name)).toEqual(['connect']);
});

it('binds the visual clip preview and visibility to the active Room turn', async () => {
  const args={videoObjectId:'11111111-1111-4111-8111-111111111111',frameObjectId:'22222222-2222-4222-8222-222222222222',title:'Clip preview',description:'A short clip',visibility:'unlisted'};
  await callAgentTool('app_tool',{app:'beeline:onboarding',tool:'video_preview',args});
  expect(calls.find(call=>call.name==='postStarterVideoPreview')!.input).toMatchObject({...args,roomId:'room-1',requestId:'request-1',taskId:'command-1',generationId:context.generationId});
});
