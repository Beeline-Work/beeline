import { describe, expect, it, vi } from 'vitest';
import { AGENT_PRESENCE_STALE_MS } from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import {
  addressedAgentOfflineNotice,
  agentPresenceFromSessionEvent,
  isAddressedAgentPresumedLive,
  isAgentPresenceOnlineWithReconnectGrace,
  isAgentOfflineAfterPresenceResolved,
  isAgentTurnActive,
  latestUtteranceByPubkey,
  offlineNoticeDecision,
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

  it('shows a signed working turn while its presence lease is still unknown', () => {
    expect(
      isAgentTurnActive({ requestId: 'fresh-turn', agentPubkey: agent, status: 'working' }, undefined),
    ).toBe(true);
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

  it('does not show the AGENT OFFLINE banner when the daemon clock runs ahead of the reader', () => {
    // Regression: an actively-replying agent whose heartbeat `observedAt` lands
    // a few seconds ahead of the mobile device's own clock (ordinary skew, not
    // staleness) must not make the Room banner claim the agent is offline.
    const now = 1_700_000_000_000;
    const skewedOnline = agentPresenceFromSessionEvent(
      presence('online', Math.floor(now / 1_000) + 5),
    )!;
    expect(isAgentPresenceOnlineWithReconnectGrace(skewedOnline, now)).toBe(true);
    expect(isAgentOfflineAfterPresenceResolved(true, 1, 1, 1)).toBe(false);
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

describe('addressedAgentOfflineNotice', () => {
  it('renders a friendly notice naming the agent when it is not presumed live', () => {
    expect(addressedAgentOfflineNotice('beebee', false)).toBe(
      'beebee seems offline right now — its host machine may be off.',
    );
  });

  it('renders nothing when the addressed agent may be live', () => {
    expect(addressedAgentOfflineNotice('beebee', true)).toBeNull();
  });

  it('renders nothing for a healthy agent regardless of name', () => {
    expect(addressedAgentOfflineNotice('alden', true)).toBeNull();
  });
});

describe('offlineNoticeDecision', () => {
  const other = 'c'.repeat(64);

  it('notifies once, then stays quiet for every later message of the same outage', () => {
    const first = offlineNoticeDecision(new Set(), agent, false);
    expect(first.notify).toBe(true);
    expect(offlineNoticeDecision(first.noticed, agent, false).notify).toBe(false);
    expect(offlineNoticeDecision(first.noticed, agent, false).notify).toBe(false);
  });

  it('never notifies for an agent that may be live', () => {
    expect(offlineNoticeDecision(new Set(), agent, true).notify).toBe(false);
  });

  it('notifies again only after the agent has read live in between', () => {
    const outage = offlineNoticeDecision(new Set(), agent, false);
    const recovered = offlineNoticeDecision(outage.noticed, agent, true);
    expect(recovered.notify).toBe(false);
    expect(recovered.noticed.has(agent)).toBe(false);
    expect(offlineNoticeDecision(recovered.noticed, agent, false).notify).toBe(true);
  });

  it('tracks each agent separately', () => {
    const first = offlineNoticeDecision(new Set(), agent, false);
    const second = offlineNoticeDecision(first.noticed, other, false);
    expect(second.notify).toBe(true);
    expect(offlineNoticeDecision(second.noticed, agent, false).notify).toBe(false);
  });
});

describe('latestUtteranceByPubkey', () => {
  it('keeps the newest relay message per signer', () => {
    expect(
      latestUtteranceByPubkey([
        { pubkey: agent, timestamp: 10, isUser: false },
        { pubkey: agent, timestamp: 40, isUser: false },
        { pubkey: agent, timestamp: 25, isUser: false },
        { pubkey: 'c'.repeat(64), timestamp: 5, isUser: false },
      ]),
    ).toEqual({ [agent]: 40, ['c'.repeat(64)]: 5 });
  });

  it('ignores the viewer, unsigned rows, and client-only notices', () => {
    expect(
      latestUtteranceByPubkey([
        { pubkey: agent, timestamp: 10, isUser: true },
        { pubkey: agent, timestamp: 20, isUser: false, isSystemNotice: true },
        { pubkey: undefined, timestamp: 30, isUser: false },
      ]),
    ).toEqual({});
  });
});

describe('isAddressedAgentPresumedLive', () => {
  const now = 1_800_000_000_000;

  it('is live on a fresh presence lease', () => {
    expect(
      isAddressedAgentPresumedLive(
        { agentPubkey: agent, status: 'online', observedAt: now - 1_000 },
        now,
        0,
        undefined,
        true,
      ),
    ).toBe(true);
  });

  it('is live while the presence snapshot has not resolved yet', () => {
    expect(isAddressedAgentPresumedLive(undefined, now, 0, undefined, false)).toBe(true);
  });

  it('accuses an agent with no lease once the snapshot has resolved', () => {
    expect(isAddressedAgentPresumedLive(undefined, now, 0, undefined, true)).toBe(false);
  });

  it('is live when the agent just spoke, even with no lease at all', () => {
    expect(isAddressedAgentPresumedLive(undefined, now, 0, now - 5_000, true)).toBe(true);
  });

  it('is live when the agent just spoke and its lease has gone stale', () => {
    expect(
      isAddressedAgentPresumedLive(
        { agentPubkey: agent, status: 'online', observedAt: now - AGENT_PRESENCE_STALE_MS - 1 },
        now,
        0,
        now - 5_000,
        true,
      ),
    ).toBe(true);
  });

  it('accuses a stale lease once the agent has been silent past the window', () => {
    expect(
      isAddressedAgentPresumedLive(
        { agentPubkey: agent, status: 'online', observedAt: now - AGENT_PRESENCE_STALE_MS - 1 },
        now,
        0,
        now - AGENT_PRESENCE_STALE_MS - 1,
        true,
      ),
    ).toBe(false);
  });

  it('honours a graceful shutdown published after the agent last spoke', () => {
    expect(
      isAddressedAgentPresumedLive(
        { agentPubkey: agent, status: 'offline', observedAt: now - 1_000 },
        now,
        0,
        now - 5_000,
        true,
      ),
    ).toBe(false);
  });

  it('keeps a restarted agent live when it spoke after its last offline marker', () => {
    expect(
      isAddressedAgentPresumedLive(
        { agentPubkey: agent, status: 'offline', observedAt: now - 60_000 },
        now,
        0,
        now - 5_000,
        true,
      ),
    ).toBe(true);
  });

  it('tolerates a daemon clock running ahead of the device', () => {
    expect(isAddressedAgentPresumedLive(undefined, now, 0, now + 30_000, true)).toBe(true);
  });
});
