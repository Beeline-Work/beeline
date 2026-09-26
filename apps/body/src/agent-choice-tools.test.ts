import { describe, expect, it } from 'vitest';
import { agentToolsFor, askChoice, openPoll, type AgentGrantDeps } from './read-only-mcp.js';

function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
): AgentGrantDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
  };
}

const options = [
  { label: 'Kraken paper', consequence: 'Works with plugin auth' },
  { label: 'Keep waiting', consequence: 'Blocked on CDP JWT', costly: true },
];

describe('the one app front door', () => {
  it('mounts connect_app where a person is answered, and no retired connector tools anywhere', () => {
    const room = agentToolsFor(true, false).map((tool) => tool.name);
    const dm = agentToolsFor(true, true).map((tool) => tool.name);
    const corner = agentToolsFor(true, false, true).map((tool) => tool.name);
    expect(room).toContain('connect_app');
    expect(dm).toContain('connect_app');
    expect(corner).not.toContain('connect_app');
    for (const names of [room, dm, corner])
      for (const retired of [
        'connect_mcp_server',
        'search_mcp_registry',
        'composio_tools',
        'composio_execute',
      ])
        expect(names).not.toContain(retired);
  });
});

describe('beeline-agent ask_choice and open_poll', () => {
  it('mounts ask_choice in Rooms, corners, and DMs, and open_poll everywhere except DMs', () => {
    expect(agentToolsFor(true, false).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['ask_choice', 'open_poll']),
    );
    expect(agentToolsFor(true, true).map((tool) => tool.name)).toContain('ask_choice');
    expect(agentToolsFor(true, true).map((tool) => tool.name)).not.toContain('open_poll');
    expect(agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('ask_choice');
  });

  it('posts ask_choice without pausing the turn', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await askChoice(
      {
        prompt: 'How do you want to push the desk past this?',
        constraint: 'CDP AgentKit needs JWT signing',
        options,
        ttl: 900,
      },
      deps({ choiceId: 'c-1', messageId: 'm-1', mode: 'question', electorateCount: 1 }, ops),
    );
    expect(ops).toEqual([
      {
        name: 'askRoomChoice',
        input: {
          roomId: 'room-1',
          prompt: 'How do you want to push the desk past this?',
          constraint: 'CDP AgentKit needs JWT signing',
          options,
          ttlSeconds: 900,
        },
      },
    ]);
    expect(reply).toContain('posted [c-1]');
    expect(reply).toContain('not paused');
    expect(reply).not.toContain('paused on this grant');
  });

  it('posts open_poll as a fact, never a mandate', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await openPoll(
      { prompt: 'Which paper API?', options, ttl: 3600 },
      deps(
        {
          choiceId: 'c-2',
          messageId: 'm-2',
          mode: 'poll',
          electorateCount: 4,
          closesAt: 1_800_000_000,
        },
        ops,
      ),
    );
    expect(ops[0]).toEqual({
      name: 'openRoomPoll',
      input: {
        roomId: 'room-1',
        prompt: 'Which paper API?',
        options,
        ttlSeconds: 3600,
      },
    });
    expect(reply).toContain('electorate 4');
    expect(reply).toContain('preference fact');
    expect(reply).toContain('tie or no votes');
  });
});
