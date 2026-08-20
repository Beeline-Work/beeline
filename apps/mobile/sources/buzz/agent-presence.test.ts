import { describe, expect, it, vi } from 'vitest';
import { AGENT_PRESENCE_STALE_MS } from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import {
  OFFLINE_NOTICE_REPEAT_WINDOW_MS,
  addressedAgentOfflineNotice,
  agentPresenceFromSessionEvent,
  offlineNoticeForSend,
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
  it('renders a friendly notice naming the agent when its presence is stale', () => {
    expect(addressedAgentOfflineNotice('beebee', false)).toBe(
      'beebee seems offline right now — its host machine may be off.',
    );
  });

  it('renders nothing when the addressed agent is online (fresh presence)', () => {
    expect(addressedAgentOfflineNotice('beebee', true)).toBeNull();
  });

  it('renders nothing for a healthy agent regardless of name', () => {
    expect(addressedAgentOfflineNotice('alden', true)).toBeNull();
  });
});

describe('offlineNoticeForSend', () => {
  const beebee = 'b'.repeat(64);
  const alden = 'a'.repeat(64);
  const roster = [
    { pubkey: beebee, name: 'beebee', handle: 'beebee' },
    { pubkey: alden, name: 'alden', handle: 'alden' },
  ];
  const base = {
    presenceResolved: true,
    isOnline: (pubkey: string) => pubkey !== beebee,
    agentName: (pubkey: string) => (pubkey === beebee ? 'beebee' : 'alden'),
  };

  it('stays silent on a Room message that does not mention the offline agent', () => {
    expect(
      offlineNoticeForSend({
        ...base,
        send: { sentText: 'shipping the release notes now', mentionableAgents: roster },
        now: 1_000,
      }),
    ).toBeNull();
  });

  it('stays silent when the message mentions a different, healthy agent', () => {
    expect(
      offlineNoticeForSend({
        ...base,
        send: { sentText: '@alden take a look', mentionableAgents: roster },
        now: 1_000,
      }),
    ).toBeNull();
  });

  it('renders exactly one notice for a message that mentions the offline agent', () => {
    expect(
      offlineNoticeForSend({
        ...base,
        send: { sentText: '@beebee are you there?', mentionableAgents: roster },
        now: 1_000,
      }),
    ).toEqual({
      agentPubkey: beebee,
      text: 'beebee seems offline right now — its host machine may be off.',
    });
  });

  it('does not repeat itself when the same agent is mentioned again moments later', () => {
    const noticedAt = new Map<string, number>();
    const first = offlineNoticeForSend({
      ...base,
      send: { sentText: '@beebee are you there?', mentionableAgents: roster },
      noticedAt,
      now: 1_000,
    });
    expect(first).not.toBeNull();
    noticedAt.set(first!.agentPubkey, 1_000);

    expect(
      offlineNoticeForSend({
        ...base,
        send: { sentText: '@beebee hello?', mentionableAgents: roster },
        noticedAt,
        now: 3_000,
      }),
    ).toBeNull();
  });

  it('speaks again once the repeat window has passed', () => {
    const noticedAt = new Map([[beebee, 1_000]]);
    expect(
      offlineNoticeForSend({
        ...base,
        send: { sentText: '@beebee still down?', mentionableAgents: roster },
        noticedAt,
        now: 1_000 + OFFLINE_NOTICE_REPEAT_WINDOW_MS,
      }),
    ).not.toBeNull();
  });

  it('never accuses an agent while its presence lease is still unknown', () => {
    expect(
      offlineNoticeForSend({
        ...base,
        presenceResolved: false,
        send: { sentText: '@beebee are you there?', mentionableAgents: roster },
        now: 1_000,
      }),
    ).toBeNull();
  });

  it('ignores a dropdown selection whose handle is no longer in the sent text', () => {
    expect(
      offlineNoticeForSend({
        ...base,
        send: {
          sentText: 'never mind, I will do it myself',
          mentionableAgents: roster,
          selectedMentions: new Map([['beebee', beebee]]),
        },
        now: 1_000,
      }),
    ).toBeNull();
  });

  it("addresses a Corner's own agent implicitly, with no mention needed", () => {
    expect(
      offlineNoticeForSend({
        ...base,
        send: { sentText: 'keep going', cornerAgentPubkey: beebee },
        now: 1_000,
      }),
    ).toMatchObject({ agentPubkey: beebee });
  });
});

describe('recovering from a stale presence lease', () => {
  const stale = { agentPubkey: agent, status: 'online' as const, observedAt: 0 };

  it('flips back online the moment a fresh heartbeat lands', () => {
    const now = AGENT_PRESENCE_STALE_MS * 3;
    expect(isAgentPresenceOnlineWithReconnectGrace(stale, now)).toBe(false);

    const recovered = mergeAgentPresence({ [agent]: stale }, {
      agentPubkey: agent,
      status: 'online',
      observedAt: now,
    });
    expect(isAgentPresenceOnlineWithReconnectGrace(recovered[agent], now)).toBe(true);
  });

  it('stays offline when the heartbeat that arrives is itself already past its lease', () => {
    // The reader has no way to tell a delivered-but-old record from a dead
    // daemon, which is why the publisher must stamp `created_at` at publish
    // time (see startAgentPresence in apps/body/src/activity.ts) rather than
    // when the heartbeat was enqueued behind a retry.
    const now = AGENT_PRESENCE_STALE_MS * 3;
    const late = mergeAgentPresence({ [agent]: stale }, {
      agentPubkey: agent,
      status: 'online',
      observedAt: now - AGENT_PRESENCE_STALE_MS - 1,
    });
    expect(isAgentPresenceOnlineWithReconnectGrace(late[agent], now)).toBe(false);
  });

  it('never lets an older record displace the newest one the reader already holds', () => {
    const now = AGENT_PRESENCE_STALE_MS * 3;
    const fresh = { agentPubkey: agent, status: 'online' as const, observedAt: now };
    const merged = mergeAgentPresence({ [agent]: fresh }, {
      agentPubkey: agent,
      status: 'offline',
      observedAt: now - 60_000,
    });
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

  it('takes the agent\'s most recent message, not the first one it finds', () => {
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
