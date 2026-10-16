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

  it('keeps workflows discoverable without mounting their schemas on ordinary turns', async () => {
    expect(agentToolsFor(true, false).map(tool => tool.name)).toContain('app_tool');
    expect(agentToolsFor(true, false).map(tool => tool.name)).not.toContain('get_workflow_run');
    const discovered = JSON.parse(await callAgentTool('app_tool', { app: 'beeline:workflow' }, 'discover'));
    expect(discovered.tools.map((tool: { name: string }) => tool.name)).toEqual(['save', 'start', 'read', 'advance', 'cancel', 'archive', 'rebind']);
    expect(calls).toEqual([]);
  });

  it('reads a returned run id without requiring a write turn', async () => {
    expect(JSON.parse(await callAgentTool('app_tool', { app: 'beeline:workflow', tool: 'read', args: { runId: 'run-1' } }, 'read'))).toMatchObject({ runId: 'run-1' });
    expect(calls).toEqual([{ name: 'getWorkflowRun', input: { roomId: 'room-1', agentId: 'agent-1', runId: 'run-1' } }]);
  });

  it('binds cancellation to the active turn and forwards its reason', async () => {
    await callAgentTool('app_tool', { app:'beeline:workflow', tool:'cancel', args:{ runId: 'run-1', reason: 'Request withdrawn' } });
    expect(calls).toEqual([{ name: 'cancelWorkflowRun', input: {
      roomId: 'room-1', agentId: 'agent-1', runId: 'run-1', reason: 'Request withdrawn',
      requestId: 'request-1', generationId: context.generationId, taskId: 'command-1',
    } }]);
  });
});

/**
 * Inside a corner, BEELINE_DAEMON_ROOM_ID still names the PARENT Room while
 * BEELINE_DAEMON_CORNER_ID names the corner itself (`monolith-corner-turn.ts`
 * mounts the agent MCP that way). A run started in the corner stores its
 * `workflow-handoff` card under the corner's own room_id, so every workflow
 * run tool must target the corner id the same way `agentScheduleRoomId()`
 * already does for scheduling — never fall back to the parent env var, or
 * the server answers 503 "workflow run is unavailable in this Room".
 */
describe('workflow run tools inside a corner', () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let context: CommandExecutionContext;
  beforeEach(async () => {
    calls.length = 0;
    context = new CommandExecutionContext(mkdtempSync(join(tmpdir(), 'workflow-tools-corner-')));
    await context.enter({ roomId: 'corner-1', turnRequestId: 'request-1', rootCommandId: 'command-1' } as AgentCommand);
    for (const [key, value] of Object.entries({
      BEELINE_DAEMON_AGENT_ID: 'agent-1', BEELINE_DAEMON_ROOM_ID: 'parent-room',
      BEELINE_DAEMON_CORNER_ID: 'corner-1',
      BEELINE_DAEMON_BASE_URL: 'http://localhost:1234', BEELINE_DAEMON_TOKEN: 'test-token',
      BEELINE_TURN_CONTEXT_FILE: context.path,
    })) vi.stubEnv(key, value);
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({ name: new URL(url).pathname.split('/').pop()!, input: JSON.parse(String(init.body)) });
      return Response.json({ runId: 'run-1', state: 'draft' });
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('reads the run stored in the corner, not the parent Room', async () => {
    await callAgentTool('app_tool', { app: 'beeline:workflow', tool: 'read', args: { runId: 'run-1' } }, 'read');
    expect(calls).toEqual([{ name: 'getWorkflowRun', input: { roomId: 'corner-1', agentId: 'agent-1', runId: 'run-1' } }]);
  });

  it('advances a run with handoff scoped to the corner', async () => {
    await callAgentTool('app_tool', { app:'beeline:workflow', tool:'advance', args:{ runId: 'run-1', outcome: 'done', contents: { note: 'ready' } } });
    expect(calls).toEqual([{ name: 'handoff', input: {
      roomId: 'corner-1', agentId: 'agent-1', runId: 'run-1', outcome: 'done', contents: { note: 'ready' },
      requestId: 'request-1', generationId: context.generationId, taskId: 'command-1',
    } }]);
  });

  it('starts, cancels and reassigns a workflow role scoped to the corner', async () => {
    await callAgentTool('app_tool', { app:'beeline:workflow', tool:'start', args:{ name: 'triage', roleBindings: { reviewer: 'agent-1' } } });
    await callAgentTool('app_tool', { app:'beeline:workflow', tool:'cancel', args:{ runId: 'run-1', reason: 'no longer needed' } });
    await callAgentTool('app_tool', { app:'beeline:workflow', tool:'rebind', args:{ runId: 'run-1', role: 'reviewer', agent: 'agent-2' } });
    expect(calls.map((call) => call.input.roomId)).toEqual(['corner-1', 'corner-1', 'corner-1']);
  });
});
