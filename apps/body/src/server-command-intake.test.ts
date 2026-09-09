import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  CommandExecutionContext,
  runServerCommandIntake,
  validateServerCommand,
} from './server-command-intake.js';
const paths: string[] = [];
afterEach(async () => {
  for (const p of paths.splice(0)) await rm(p, { recursive: true, force: true });
});
const command = (id = 'c1', action: AgentCommand['action'] = 'input'): AgentCommand => ({
  id,
  roomId: 'room',
  agentId: 'agent',
  sourceMessageId: id,
  turnRequestId: 'turn',
  rootCommandId: 'root',
  rootSourceMessageId: 'human',
  agentDepth: 0,
  action,
  reason: 'human_tag',
  source: {
    id,
    authorId: 'human',
    body: 'Do it',
    createdAt: 1,
    type: 'message',
    mentionIds: [],
    attachments: [],
  },
});
async function context() {
  const dir = await mkdtemp(join(tmpdir(), 'command-test-'));
  paths.push(dir);
  return new CommandExecutionContext(dir);
}
describe('command intake mechanics', () => {
  it('refuses an older server without ever reading shared traffic', async () => {
    const execute = vi.fn(async () => ({ items: [command().source] }));
    await expect(
      runServerCommandIntake({
        api: { execute } as unknown as DaemonApiClient,
        roomId: 'room',
        agentId: 'agent',
        context: await context(),
        run: vi.fn(),
        stop: vi.fn(),
      }),
    ).rejects.toThrow('protocol');
    expect(execute.mock.calls.map((c) => c[0])).toEqual(['getAgentCommands']);
  });
  it('rejects wrong-target and malformed commands', () => {
    for (const c of [
      { ...command(), agentId: 'other' },
      { ...command(), roomId: 'other' },
      { ...command(), agentDepth: 4 },
      { ...command(), action: 'message' },
    ])
      expect(() => validateServerCommand(c as AgentCommand, 'room', 'agent')).toThrow();
  });
  it('does not start work after losing a claim', async () => {
    const controller = new AbortController(),
      run = vi.fn();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      controller.abort();
      throw new Error('claim conflict');
    });
    await runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: controller.signal,
      run,
      stop: vi.fn(),
    });
    expect(run).not.toHaveBeenCalled();
  });
  it('processes a stop while an authorized input is running', async () => {
    const controller = new AbortController();
    let reads = 0,
      release = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = vi.fn(() => {
      release();
      controller.abort();
    });
    const execute = vi.fn(async (name: string) =>
      name === 'getAgentCommands'
        ? {
            commandProtocol: 1,
            commands: [command(reads++ ? 'stop' : 'input', reads > 1 ? 'stop' : 'input')],
          }
        : { id: 'ok' },
    );
    await runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: controller.signal,
      run,
      stop,
      pollMs: 1,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('turn');
    expect(execute).toHaveBeenCalledWith('acknowledgeAgentCommand', expect.anything());
  });
  it('binds every output to the claimed generation and request', async () => {
    const ctx = await context();
    await ctx.enter(command());
    const execute = vi.fn(async () => ({ id: 'ok' }));
    await ctx
      .bind({ execute } as unknown as DaemonApiClient)
      .execute('postAgentAttachment', { roomId: 'room', attachment: { url: 'url' } });
    expect(execute).toHaveBeenCalledWith(
      'postAgentAttachment',
      expect.objectContaining({ requestId: 'turn', generationId: ctx.generationId }),
    );
  });
});
