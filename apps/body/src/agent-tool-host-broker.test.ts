import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentToolHostBroker } from './agent-tool-host-broker.js';
import { callMcpTool, listMcpToolNames } from './mcp-inventory.js';
import { assertBeelineAgentToolHandshake } from './agent-tool-contract.js';

describe('AgentToolHostBroker', () => {
  it('advertises the exact Phase-1 inventory and dispatches through a session capability', async () => {
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
      await expect(listMcpToolNames(server)).resolves.toEqual([
        'read_mandate',
        'open_corner',
        'close_corner',
        'deliver',
      ]);
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

  it('keeps a session capability valid across transport reconnects', async () => {
    const broker = new AgentToolHostBroker(
      resolve(process.cwd(), 'src', 'agent-tool-mcp-proxy.ts'),
    );
    const invoke = vi.fn(async () => ({
      schema_version: 1,
      generation: { event_id: 'a'.repeat(64), generation: 1 },
      grants: [],
      defaults: [],
      blockers: [],
    }));
    const server = await broker.mcpServer({ channelId: 'room', invoke });
    try {
      await expect(listMcpToolNames(server)).resolves.toContain('read_mandate');
      await expect(callMcpTool(server, 'read_mandate', {})).resolves.toMatchObject({
        structuredContent: { schema_version: 1 },
      });
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });

  it('fails closed when server identity, schema, or inventory is broken', () => {
    expect(() =>
      assertBeelineAgentToolHandshake({
        serverInfo: { name: 'broken', version: '1' },
        toolNames: ['read_mandate', 'open_corner', 'close_corner', 'deliver'],
      }),
    ).toThrow('identity/schema handshake failed');
    expect(() =>
      assertBeelineAgentToolHandshake({
        serverInfo: { name: 'beeline-agent-tools', version: '1' },
        toolNames: ['read_mandate'],
      }),
    ).toThrow('inventory handshake failed');
  });
});
