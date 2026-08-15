import { describe, expect, it, vi } from 'vitest';
import { AGENT_PRESENCE_STALE_MS } from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import {
  agentPresenceFromSessionEvent,
  isAgentPresenceOnlineWithReconnectGrace,
  isAgentOfflineAfterPresenceResolved,
  isAgentTurnActive,
  presenceMapFromSessionEvents,
  reconnectPresenceAfterForeground,
} from './agent-presence';

const agent = 'b'.repeat(64);

function presence(
  status: 'online' | 'offline',
  createdAt: number,
  pubkey = agent,
  generationId?: string,
): SessionEvent {
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
        ...(generationId ? [['generation', generationId]] : []),
      ],
    },
  };
}

describe('mobile agent presence projection', () => {
  it('does not call an unknown presence snapshot offline', () => {
    expect(isAgentOfflineAfterPresenceResolved(false, 1, 0, 0)).toBe(false);
    expect(isAgentOfflineAfterPresenceResolved(true, 1, 0, 0)).toBe(false);
    expect(isAgentOfflineAfterPresenceResolved(true, 2, 1, 0)).toBe(false);
    expect(isAgentOfflineAfterPresenceResolved(true, 1, 1, 0)).toBe(true);
    expect(isAgentOfflineAfterPresenceResolved(true, 1, 1, 1)).toBe(false);
  });

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

  it('binds active turns to the current online daemon generation', () => {
    const current = agentPresenceFromSessionEvent(presence('online', 10, agent, 'daemon-new'));
    expect(current).toMatchObject({ generationId: 'daemon-new' });
    expect(
      isAgentTurnActive(
        {
          requestId: 'current-turn',
          agentPubkey: agent,
          status: 'working',
          generationId: 'daemon-new',
        },
        current,
        10_000,
      ),
    ).toBe(true);
    expect(
      isAgentTurnActive(
        { requestId: 'stale-turn', agentPubkey: agent, status: 'working' },
        current,
        10_000,
      ),
    ).toBe(false);
    expect(
      isAgentTurnActive(
        {
          requestId: 'offline-turn',
          agentPubkey: agent,
          status: 'working',
          generationId: 'daemon-new',
        },
        agentPresenceFromSessionEvent(presence('offline', 11, agent, 'daemon-new')),
        11_000,
      ),
    ).toBe(false);
  });

  it('keeps explicit offline when online and offline share a relay second', () => {
    expect(presenceMapFromSessionEvents([presence('online', 4), presence('offline', 4)])).toEqual({
      [agent]: { agentPubkey: agent, status: 'offline', observedAt: 4_000 },
    });
    expect(presenceMapFromSessionEvents([presence('offline', 4), presence('online', 4)])).toEqual({
      [agent]: { agentPubkey: agent, status: 'offline', observedAt: 4_000 },
    });
  });

  it('keeps last-known online through foreground reconnect without masking real offline', () => {
    const now = 1_700_000_000_000;
    const staleOnline = agentPresenceFromSessionEvent(
      presence('online', now - AGENT_PRESENCE_STALE_MS - 1),
    );
    const explicitOffline = agentPresenceFromSessionEvent(presence('offline', now));
    const graceUntil = now + AGENT_PRESENCE_STALE_MS;

    expect(isAgentPresenceOnlineWithReconnectGrace(staleOnline, now, graceUntil)).toBe(true);
    expect(isAgentPresenceOnlineWithReconnectGrace(explicitOffline, now, graceUntil)).toBe(false);
    expect(isAgentPresenceOnlineWithReconnectGrace(staleOnline, graceUntil + 1, graceUntil)).toBe(
      false,
    );
    expect(
      isAgentPresenceOnlineWithReconnectGrace(
        agentPresenceFromSessionEvent(presence('online', now)),
        now,
        0,
      ),
    ).toBe(true);
  });

  it('reinstalls foreground delivery before backfilling the missed heartbeat', async () => {
    const order: string[] = [];
    const installSubscription = vi.fn(async () => {
      order.push('subscribe');
    });
    const backfill = vi.fn(async () => {
      order.push('backfill');
      return [presence('online', 1_700_000_000)];
    });

    const refreshed = await reconnectPresenceAfterForeground(installSubscription, backfill);

    expect(order).toEqual(['subscribe', 'backfill']);
    expect(refreshed[agent]).toMatchObject({ status: 'online' });
  });
});
