import { describe, expect, it } from 'vitest';
import { MESSAGE_REACTION_EMOJIS } from '@beeline/api-contract/phone';
import { agentToolsFor, reactToMessage, type AgentScheduleDeps } from './read-only-mcp.js';

describe('beeline-agent reaction tool', () => {
  it('declares the supported emoji and is available on every agent conversation surface', () => {
    for (const tools of [
      agentToolsFor(true, false),
      agentToolsFor(true, true),
      agentToolsFor(true, false, true),
    ]) {
      const tool = tools.find((entry) => entry.name === 'react_to_message');
      expect(tool?.inputSchema).toMatchObject({
        required: ['messageId', 'emoji'],
        properties: { emoji: { enum: [...MESSAGE_REACTION_EMOJIS] } },
      });
    }
    expect(agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('react_to_message');
  });

  it('reacts as the authenticated agent in the current Room', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const deps: AgentScheduleDeps = {
      roomId: 'room-1',
      execute: async (name, input) => {
        calls.push({ name, input });
        return { id: 'write-1', createdAt: 1 };
      },
    };

    await expect(reactToMessage({ messageId: 'message-1', emoji: '🎉' }, deps)).resolves.toBe(
      'Reacted 🎉 to message message-1.',
    );
    expect(calls).toEqual([
      {
        name: 'reactToRoomMessage',
        input: { roomId: 'room-1', messageId: 'message-1', emoji: '🎉' },
      },
    ]);
  });

  it('refuses unsupported emoji before calling the daemon', async () => {
    const calls: string[] = [];
    const deps: AgentScheduleDeps = {
      roomId: 'room-1',
      execute: async (name) => {
        calls.push(name);
        return {};
      },
    };

    await expect(reactToMessage({ messageId: 'message-1', emoji: '🔥' }, deps)).rejects.toThrow(
      /emoji must be one of/,
    );
    expect(calls).toEqual([]);
  });
});
