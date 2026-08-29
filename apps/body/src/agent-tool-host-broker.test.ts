import { resolve } from 'node:path';
import { createConnection } from 'node:net';
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
        'read_corner',
        'list_corners',
        'request_mandate',
        'open_corner',
        'close_corner',
        'schedule',
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
      schema_version: 3,
      generation: { event_id: 'a'.repeat(64), generation: 1 },
      grants: [],
      defaults: [],
      blockers: [],
    }));
    const server = await broker.mcpServer({ channelId: 'room', invoke });
    try {
      await expect(listMcpToolNames(server)).resolves.toContain('read_mandate');
      await expect(callMcpTool(server, 'read_mandate', {})).resolves.toMatchObject({
        structuredContent: { schema_version: 3 },
      });
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });

  it('answers a truth read while an open_corner call is still provisioning', async () => {
    const broker = new AgentToolHostBroker(
      resolve(process.cwd(), 'src', 'agent-tool-mcp-proxy.ts'),
    );
    let finishOpen!: () => void;
    const openFinished = new Promise<void>((resolvePromise) => {
      finishOpen = resolvePromise;
    });
    const invoke = vi.fn(async (tool) => {
      if (tool === 'open_corner') {
        await openFinished;
        return { status: 'executed', corner_id: 'corner' };
      }
      return { status: 'executed', exists: true, corner_id: 'corner', state: 'opening' };
    });
    const endpoint = await broker.mcpServer({ channelId: 'room', invoke });
    const port = Number(endpoint.args.at(-2));
    const token = endpoint.args.at(-1)!;
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setEncoding('utf8');
    const replies = new Map<number, Record<string, unknown>>();
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const reply = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        replies.set(Number(reply.id), reply);
        buffer = buffer.slice(newline + 1);
      }
    });
    const waitForReply = async (id: number): Promise<Record<string, unknown>> => {
      await vi.waitFor(() => expect(replies.has(id)).toBe(true));
      return replies.get(id)!;
    };
    try {
      await new Promise<void>((resolvePromise) => socket.once('connect', resolvePromise));
      socket.write(`${JSON.stringify({ token })}\n`);
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'open_corner', arguments: { objective: 'Slow setup' } } })}\n`,
      );
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_corner', arguments: {} } })}\n`,
      );

      await expect(waitForReply(2)).resolves.toMatchObject({
        result: { structuredContent: { exists: true, state: 'opening' } },
      });
      expect(replies.has(1)).toBe(false);
      finishOpen();
      await expect(waitForReply(1)).resolves.toMatchObject({
        result: { structuredContent: { status: 'executed', corner_id: 'corner' } },
      });
    } finally {
      finishOpen();
      socket.destroy();
      await broker.close();
    }
  });

  it('fails closed when server identity, schema, or inventory is broken', () => {
    expect(() =>
      assertBeelineAgentToolHandshake({
        serverInfo: { name: 'broken', version: '3' },
        toolNames: [
          'read_mandate',
          'read_corner',
          'list_corners',
          'request_mandate',
          'open_corner',
          'close_corner',
          'schedule',
          'deliver',
        ],
      }),
    ).toThrow('identity/schema handshake failed');
    expect(() =>
      assertBeelineAgentToolHandshake({
        serverInfo: { name: 'beeline-agent-tools', version: '3' },
        toolNames: ['read_mandate'],
      }),
    ).toThrow('inventory handshake failed');
  });
});
