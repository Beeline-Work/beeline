import { describe, expect, it, vi } from 'vitest';
import { agentCommandCatalogPublisher } from './agent-command-catalog.js';

describe('agent command catalog publisher', () => {
  it('posts full model, usage, status, and permission command metadata', async () => {
    const execute = vi.fn().mockResolvedValue({ id: 'ok', createdAt: 1 });
    const publish = agentCommandCatalogPublisher({
      api: { execute } as never,
      agentId: 'agent-id',
      workspaceId: 'workspace-id',
    });
    const commands = [
      { name: 'model', description: 'Show or change the agent model' },
      { name: 'usage', description: 'Show usage status' },
      { name: 'status', inputHint: 'model and account details' },
      { name: 'permissions', description: 'Show permission rules' },
    ];

    publish(commands);
    await vi.waitFor(() =>
      expect(execute).toHaveBeenCalledWith('postAgentCommands', {
        agentId: 'agent-id',
        workspaceId: 'workspace-id',
        commands,
      }),
    );
  });

  it('contains publication failures instead of rejecting an agent turn', async () => {
    const failure = new Error('server unavailable');
    const report = vi.fn();
    const publish = agentCommandCatalogPublisher({
      api: { execute: vi.fn().mockRejectedValue(failure) } as never,
      agentId: 'agent-id',
      workspaceId: 'workspace-id',
      report,
    });

    expect(publish([{ name: 'status' }])).toBeUndefined();
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(failure));
  });
});
