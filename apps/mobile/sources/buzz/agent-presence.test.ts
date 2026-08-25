import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_PRESENCE_STALE_MS,
  isAgentPresenceOnline,
  type ReadEvent,
} from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import {
  agentPresenceFromSessionEvent,
  isAgentPresenceOnlineWithReconnectGrace,
  isAgentOfflineAfterPresenceResolved,
  isAgentTurnActive,
  mergeAgentPresence,
  presenceMapFromSessionEvents,
  presenceWithMessageLiveness,
  reconnectPresenceAfterForeground,
} from './agent-presence';
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';

const agent = 'b'.repeat(64);

function presence(
  status: 'online' | 'offline',
  createdAt: number,
  pubkey = agent,
  generationId?: string,
): SessionEvent {
  return {
    type: 'read-model',
    sessionId: 'room',
    event: {
      type: 'session-update',
      eventId: `${status}-${createdAt}`,
      authorPubkey: pubkey,
      createdAt,
      sourceKind: 30078,
      signature: 'verified',
      scope: 'channel',
      channelId: 'room',
      workspaceId: 'workspace',
      sessionId: 'room',
      update: {
        kind: 'presence',
        agentPubkey: pubkey,
        status,
        ...(generationId ? { generationId } : {}),
      },
    } as ReadEvent,
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
      isAgentTurnActive(
        { requestId: 'fresh-turn', agentPubkey: agent, status: 'working' },
        undefined,
      ),
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

  it('resolves a daemon-published kind:30078 heartbeat addressed by d, not h', () => {
    // Presence is parameterized-replaceable: the relay indexes it by `d`.
    // An `#h` filter matches nothing — that class already made the Members
    // directory report every agent OFFLINE, including a live Codex daemon.
    // The publisher (`postAgentPresence`) and this reader must share the
    // `d=agent-presence:<channelId>` key; harness kind is not on the wire.
    const now = Math.floor(Date.now() / 1000);
    const published = presence('online', now);
    const map = presenceMapFromSessionEvents([published]);
    expect(isAgentPresenceOnline(map[agent])).toBe(true);
  });

  it('keeps last-known online through foreground reconnect without masking real offline', () => {
    const now = 1_700_000_000_000;
    const staleOnline = agentPresenceFromSessionEvent(
      presence('online', Math.floor((now - AGENT_PRESENCE_STALE_MS - 1) / 1_000)),
    );
    const explicitOffline = agentPresenceFromSessionEvent(presence('offline', now / 1_000));
    const graceUntil = now + AGENT_PRESENCE_STALE_MS;

    expect(isAgentPresenceOnlineWithReconnectGrace(staleOnline, now, graceUntil)).toBe(true);
    expect(isAgentPresenceOnlineWithReconnectGrace(explicitOffline, now, graceUntil)).toBe(false);
    expect(isAgentPresenceOnlineWithReconnectGrace(staleOnline, graceUntil + 1, graceUntil)).toBe(
      false,
    );
    expect(
      isAgentPresenceOnlineWithReconnectGrace(
        agentPresenceFromSessionEvent(presence('online', now / 1_000)),
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

describe('recovering from a stale presence lease', () => {
  const stale = { agentPubkey: agent, status: 'online' as const, observedAt: 0 };

  it('flips back online the moment a fresh heartbeat lands', () => {
    const now = AGENT_PRESENCE_STALE_MS * 3;
    expect(isAgentPresenceOnlineWithReconnectGrace(stale, now)).toBe(false);

    const recovered = mergeAgentPresence(
      { [agent]: stale },
      {
        agentPubkey: agent,
        status: 'online',
        observedAt: now,
      },
    );
    expect(isAgentPresenceOnlineWithReconnectGrace(recovered[agent], now)).toBe(true);
  });

  it('stays offline when the heartbeat that arrives is itself already past its lease', () => {
    // The reader has no way to tell a delivered-but-old record from a dead
    // daemon, which is why the publisher must stamp `created_at` at publish
    // time (see startAgentPresence in apps/body/src/activity.ts) rather than
    // when the heartbeat was enqueued behind a retry.
    const now = AGENT_PRESENCE_STALE_MS * 3;
    const late = mergeAgentPresence(
      { [agent]: stale },
      {
        agentPubkey: agent,
        status: 'online',
        observedAt: now - AGENT_PRESENCE_STALE_MS - 1,
      },
    );
    expect(isAgentPresenceOnlineWithReconnectGrace(late[agent], now)).toBe(false);
  });

  it('never lets an older record displace the newest one the reader already holds', () => {
    const now = AGENT_PRESENCE_STALE_MS * 3;
    const fresh = { agentPubkey: agent, status: 'online' as const, observedAt: now };
    const merged = mergeAgentPresence(
      { [agent]: fresh },
      {
        agentPubkey: agent,
        status: 'offline',
        observedAt: now - 60_000,
      },
    );
    expect(merged[agent]).toBe(fresh);
    expect(isAgentPresenceOnlineWithReconnectGrace(merged[agent], now)).toBe(true);
  });
});

/**
 * An agent's own visible output is evidence about the agent.
 *
 * The heartbeat is a best-effort publish: `publishEvent` does not retry a
 * relay quota rejection, and the captain's daemon log opens with
 * `agent presence online failed: HTTP 429 rate-limited`. Two of those against a
 * 120s lease is enough to accuse an agent that is answering in the transcript
 * at that very moment.
 */
describe('an agent message counts as liveness', () => {
  const agentPubkeys = new Set([agent]);
  function message(overrides: Partial<ChatDisplayMessage>): ChatDisplayMessage {
    return {
      id: 'm1',
      text: 'here is the answer',
      isUser: false,
      timestamp: 0,
      pubkey: agent,
      isAgentAuthor: true,
      ...overrides,
    } as ChatDisplayMessage;
  }

  it('keeps an agent online whose heartbeat was swallowed but who just spoke', () => {
    const now = 5_000_000;
    const stale = {
      [agent]: { agentPubkey: agent, status: 'online' as const, observedAt: now - 10 * 60_000 },
    };
    expect(isAgentPresenceOnlineWithReconnectGrace(stale[agent], now)).toBe(false);

    const corrected = presenceWithMessageLiveness(
      stale,
      [message({ timestamp: now - 1_000 })],
      agentPubkeys,
    );
    expect(isAgentPresenceOnlineWithReconnectGrace(corrected[agent], now)).toBe(true);
  });

  it('never lets an old message override a newer explicit offline marker', () => {
    const now = 5_000_000;
    const marked = {
      [agent]: { agentPubkey: agent, status: 'offline' as const, observedAt: now - 1_000 },
    };
    const corrected = presenceWithMessageLiveness(
      marked,
      [message({ timestamp: now - 60_000 })],
      agentPubkeys,
    );
    expect(corrected[agent]!.status).toBe('offline');
  });

  it('does let a message after an offline marker bring the agent back', () => {
    const now = 5_000_000;
    const marked = {
      [agent]: { agentPubkey: agent, status: 'offline' as const, observedAt: now - 60_000 },
    };
    const corrected = presenceWithMessageLiveness(
      marked,
      [message({ timestamp: now - 1_000 })],
      agentPubkeys,
    );
    expect(isAgentPresenceOnlineWithReconnectGrace(corrected[agent], now)).toBe(true);
  });

  it('ignores rows the agent did not sign', () => {
    const now = 5_000_000;
    const corrected = presenceWithMessageLiveness(
      {},
      [
        // The client-only offline notice itself: rendered into the transcript
        // by this device, never published by anyone.
        message({ timestamp: now, isSystemNotice: true }),
        // A person's message, and a message from an unrelated key.
        message({ id: 'm2', timestamp: now, pubkey: 'c'.repeat(64), isAgentAuthor: false }),
      ],
      agentPubkeys,
    );
    expect(corrected[agent]).toBeUndefined();
  });

  it('is a no-op when the Room has no registered agents', () => {
    const presences = {};
    expect(presenceWithMessageLiveness(presences, [message({ timestamp: 1 })], new Set())).toBe(
      presences,
    );
  });

  it("takes the agent's most recent message, not the first one it finds", () => {
    const now = 5_000_000;
    const corrected = presenceWithMessageLiveness(
      {},
      [
        message({ id: 'old', timestamp: now - 10 * 60_000 }),
        message({ id: 'new', timestamp: now - 1_000 }),
      ],
      agentPubkeys,
    );
    expect(isAgentPresenceOnlineWithReconnectGrace(corrected[agent], now)).toBe(true);
  });
});
