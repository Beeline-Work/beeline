import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';
import { CommandExecutionContext } from './server-command-intake.js';

describe('workflow run tools', () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let context: CommandExecutionContext;
  beforeEach(async () => {
    calls.length = 0;
    context = new CommandExecutionContext(mkdtempSync(join(tmpdir(), 'workflow-tools-')));
    await context.enter({ roomId: 'room-1', turnRequestId: 'request-1', rootCommandId: 'command-1' } as AgentCommand);
    for (const [key, value] of Object.entries({
      BEELINE_DAEMON_AGENT_ID: 'agent-1', BEELINE_DAEMON_ROOM_ID: 'room-1',
      BEELINE_DAEMON_BASE_URL: 'http://localhost:1234', BEELINE_DAEMON_TOKEN: 'test-token',
      BEELINE_TURN_CONTEXT_FILE: context.path,
    })) vi.stubEnv(key, value);
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({ name: new URL(url).pathname.split('/').pop()!, input: JSON.parse(String(init.body)) });
      return Response.json({ runId: 'run-1', state: 'draft' });
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('offers read and cancel alongside workflows on Rooms, DMs and corners', () => {
    for (const tools of [agentToolsFor(true, false), agentToolsFor(true, true), agentToolsFor(true, false, true)]) {
      expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['get_workflow_run', 'cancel_workflow_run']));
    }
    expect(agentToolsFor(true, false, false, false, true, false, false).map(t => t.name)).not.toContain('get_workflow_run');
  });

  it('reads a returned run id without requiring a write turn', async () => {
    expect(JSON.parse(await callAgentTool('get_workflow_run', { runId: 'run-1' }))).toMatchObject({ runId: 'run-1' });
    expect(calls).toEqual([{ name: 'getWorkflowRun', input: { roomId: 'room-1', agentId: 'agent-1', runId: 'run-1' } }]);
  });

  it('binds cancellation to the active turn and forwards its reason', async () => {
    await callAgentTool('cancel_workflow_run', { runId: 'run-1', reason: 'Request withdrawn', actorId: 'forged' });
    expect(calls).toEqual([{ name: 'cancelWorkflowRun', input: {
      roomId: 'room-1', agentId: 'agent-1', runId: 'run-1', reason: 'Request withdrawn',
      requestId: 'request-1', generationId: context.generationId, taskId: 'command-1',
    } }]);
  });
});
