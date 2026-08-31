import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentToolHostBroker } from './agent-tool-host-broker.js';
import { callMcpTool, listMcpToolNames } from './mcp-inventory.js';

describe('AgentToolHostBroker', () => {
  it('advertises and dispatches the exact two-verb inventory', async () => {
    const broker = new AgentToolHostBroker(
      resolve(process.cwd(), 'src', 'agent-tool-mcp-proxy.ts'),
    );
    const invoke = vi.fn(async (_tool, args) => ({
      status: 'executed',
      event_id: 'event',
      result: args,
    }));
    const server = await broker.mcpServer({ channelId: 'room', invoke });
    try {
      await expect(listMcpToolNames(server)).resolves.toEqual(['open_corner', 'close_corner']);
      const fresh = await broker.mcpServer({ channelId: 'room', invoke });
      await expect(
        callMcpTool(fresh, 'open_corner', { objective: 'Add a haiku' }),
      ).resolves.toMatchObject({
        structuredContent: { status: 'executed', event_id: 'event' },
      });
      expect(invoke).toHaveBeenCalledWith('open_corner', { objective: 'Add a haiku' });
    } finally {
      await broker.close();
    }
  });

  it('keeps a session capability usable across separate calls', async () => {
    const broker = new AgentToolHostBroker(
      resolve(process.cwd(), 'src', 'agent-tool-mcp-proxy.ts'),
    );
    const invoke = vi.fn(async () => ({
      status: 'executed',
      event_id: 'closed',
      result: { corner_id: 'corner', state: 'closed' },
    }));
    try {
      const first = await broker.mcpServer({ channelId: 'corner', invoke });
      await expect(
        callMcpTool(first, 'close_corner', { corner_id: 'corner' }),
      ).resolves.toMatchObject({ structuredContent: { status: 'executed' } });
      const second = await broker.mcpServer({ channelId: 'corner', invoke });
      await expect(listMcpToolNames(second)).resolves.toEqual(['open_corner', 'close_corner']);
    } finally {
      await broker.close();
    }
  });

  it('revokes every issued endpoint when the broker closes', async () => {
    const broker = new AgentToolHostBroker(
      resolve(process.cwd(), 'src', 'agent-tool-mcp-proxy.ts'),
    );
    const server = await broker.mcpServer({
      channelId: 'room',
      invoke: async () => ({ status: 'executed' }),
    });
    await broker.close();
    await expect(listMcpToolNames(server)).rejects.toThrow();
  });
});
