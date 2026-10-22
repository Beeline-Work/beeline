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
it('discovers both cards without an external connection and binds writes to the active turn',async()=>{
  const discovered=JSON.parse(await callAgentTool('app_tool',{app:'beeline:onboarding'},'discover'));
  expect(discovered.tools.map((t:{name:string})=>t.name)).toEqual(['repository','starters']);
  calls.length = 0;
  for (const tool of ['repository','starters']) await callAgentTool('app_tool',{app:'beeline:onboarding',tool,args:{}});
  expect(calls.filter(call=>call.name === 'postRepositoryOnboarding').map(call=>call.name)).toEqual(['postRepositoryOnboarding','postRepositoryOnboarding']);
  expect(calls.filter(call=>call.name === 'postRepositoryOnboarding').map(call=>call.input.kind)).toEqual(['repository','starters']);
  expect(calls.find(call=>call.name === 'postRepositoryOnboarding')!.input).toMatchObject({roomId:'room-1',requestId:'request-1',generationId:context.generationId});
});

it('hides the new tools when server eligibility is absent', async () => {
  vi.stubGlobal('fetch', async () => Response.json({resolution:'none'}));
  await expect(callAgentTool('app_tool',{app:'beeline:onboarding'},'discover')).rejects.toThrow('unavailable');
  const discovered = JSON.parse(await callAgentTool('connect',{mode:'discover'},'discover'));
  expect(discovered.capabilities).not.toContain('beeline:onboarding');
});
