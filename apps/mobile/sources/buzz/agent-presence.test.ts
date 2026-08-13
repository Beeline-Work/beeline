import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/sync/transport';
import { agentPresenceFromSessionEvent, presenceMapFromSessionEvents } from './agent-presence';

const agent = 'b'.repeat(64);

function presence(status: 'online' | 'offline', createdAt: number, pubkey = agent): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'room',
    payload: {
      id: `${status}-${createdAt}`,
      content: `Agent ${status}.`,
      pubkey,
      createdAt,
      tags: [
        ['h', 'room'],
        ['d', 'agent-presence:room'],
        ['t', 'agent-presence'],
        ['agent', agent],
        ['status', status],
      ],
    },
  };
}

describe('mobile agent presence projection', () => {
  it('projects self-signed seconds timestamps into millisecond leases', () => {
    expect(agentPresenceFromSessionEvent(presence('online', 1_700_000_000))).toEqual({
      agentPubkey: agent,
      status: 'online',
      observedAt: 1_700_000_000_000,
    });
  });

  it('rejects a presence marker that names another agent', () => {
    expect(agentPresenceFromSessionEvent(presence('online', 1, 'c'.repeat(64)))).toBeUndefined();
  });

  it('keeps explicit offline when online and offline share a relay second', () => {
    expect(presenceMapFromSessionEvents([presence('online', 4), presence('offline', 4)])).toEqual({
      [agent]: { agentPubkey: agent, status: 'offline', observedAt: 4_000 },
    });
    expect(presenceMapFromSessionEvents([presence('offline', 4), presence('online', 4)])).toEqual({
      [agent]: { agentPubkey: agent, status: 'offline', observedAt: 4_000 },
    });
  });
});
