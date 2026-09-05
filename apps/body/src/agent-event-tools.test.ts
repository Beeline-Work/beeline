import { describe, expect, it } from 'vitest';
import {
  agentToolsFor,
  emitEvent,
  listEventSubscriptions,
  subscribeEvents,
  type AgentScheduleDeps,
} from './read-only-mcp.js';

type Call = { name: string; input: Record<string, unknown> };

function deps(
  calls: Call[],
  answers: Record<string, Record<string, unknown> | Error> = {},
): AgentScheduleDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      calls.push({ name, input: input as Record<string, unknown> });
      const answer = answers[name];
      if (answer instanceof Error) throw answer;
      return answer ?? { id: 'w', createdAt: 1 };
    },
  };
}

describe('beeline-agent event tools', () => {
  it('an agent subscribes itself, and the reply names the whole resulting list', async () => {
    const calls: Call[] = [];
    const result = await subscribeEvents(
      { kinds: ['joined'] },
      deps(calls, { setEventSubscriptions: { kinds: ['joined'] } }),
    );
    expect(calls).toEqual([
      { name: 'setEventSubscriptions', input: { roomId: 'room-1', kinds: ['joined'] } },
    ]);
    expect(result).toContain('joined');
    expect(result).toContain('You now react to');
  });

  it('refuses a kind that is not a server event kind, without calling the daemon', async () => {
    const calls: Call[] = [];
    await expect(subscribeEvents({ kinds: ['agent:handoff'] }, deps(calls))).rejects.toThrow(
      /not an event kind you can subscribe to: agent:handoff/,
    );
    await expect(subscribeEvents({ kinds: ['everything'] }, deps(calls))).rejects.toThrow(
      /not an event kind/,
    );
    expect(calls).toEqual([]);
  });

  it('an empty subscription list is a legal answer and says the agent reacts to nothing', async () => {
    const calls: Call[] = [];
    const result = await subscribeEvents(
      { kinds: [] },
      deps(calls, { setEventSubscriptions: { kinds: [] } }),
    );
    expect(calls[0]?.input).toEqual({ roomId: 'room-1', kinds: [] });
    expect(result).toContain('react to no events');
  });

  it('lists what the agent currently reacts to', async () => {
    const calls: Call[] = [];
    const result = await listEventSubscriptions(
      deps(calls, { listEventSubscriptions: { kinds: ['joined', 'merged'] } }),
    );
    expect(calls).toEqual([{ name: 'listEventSubscriptions', input: { roomId: 'room-1' } }]);
    expect(result).toContain('joined, merged');
  });

  it('emit_event forwards kind, sentence and mentions, and never a cause', async () => {
    const calls: Call[] = [];
    const result = await emitEvent(
      { kind: 'agent:handoff', consequence: 'the branch is ready', mentionAgentIds: ['agent-b'] },
      deps(calls),
    );
    expect(calls).toEqual([
      {
        name: 'postRoomEvent',
        input: {
          roomId: 'room-1',
          kind: 'agent:handoff',
          consequence: 'the branch is ready',
          mentionAgentIds: ['agent-b'],
        },
      },
    ]);
    expect(Object.keys(calls[0]?.input ?? {})).not.toContain('causeId');
    expect(result).toContain('agent:handoff');
  });

  it('refuses a server kind, a malformed kind, an empty sentence and too many mentions', async () => {
    const calls: Call[] = [];
    await expect(emitEvent({ kind: 'joined', consequence: 'hello' }, deps(calls))).rejects.toThrow(
      /a fact the server states/,
    );
    await expect(
      emitEvent({ kind: 'agent:Handoff', consequence: 'hello' }, deps(calls)),
    ).rejects.toThrow(/agent:<slug>/);
    await expect(emitEvent({ kind: 'agent:x', consequence: '   ' }, deps(calls))).rejects.toThrow(
      /one sentence/,
    );
    await expect(
      emitEvent(
        { kind: 'agent:x', consequence: 'ok', mentionAgentIds: ['a', 'b', 'c', 'd'] },
        deps(calls),
      ),
    ).rejects.toThrow(/at most 3 agents/);
    expect(calls).toEqual([]);
  });

  it("surfaces the server's refusal verbatim, so the emitting model reads why nothing was posted", async () => {
    const calls: Call[] = [];
    await expect(
      emitEvent(
        { kind: 'agent:ping', consequence: 'again' },
        deps(calls, {
          postRoomEvent: new Error(
            'daemon operation postRoomEvent failed (400: this event would sit 5 events deep and the limit is 4; nothing was posted.)',
          ),
        }),
      ),
    ).rejects.toThrow(/5 events deep/);
  });

  it('mounts the event tools on the agent surface, in a Room and in a direct message', () => {
    const room = agentToolsFor(true, false).map((tool) => tool.name);
    const dm = agentToolsFor(true, true).map((tool) => tool.name);
    for (const name of ['subscribe_events', 'list_event_subscriptions', 'emit_event']) {
      expect(room).toContain(name);
      expect(dm).toContain(name);
    }
    expect(agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('subscribe_events');
  });
});
