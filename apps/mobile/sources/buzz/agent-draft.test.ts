import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/sync/transport';
import { agentDraftFromSessionEvent } from './agent-draft';

const agent = 'b'.repeat(64);

function draft(
  text: string,
  createdAt: number,
  overrides: {
    pubkey?: string;
    sessionId?: string;
    requestId?: string;
    agentTag?: string;
    status?: string;
  } = {},
): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'room',
    payload: {
      id: `draft-${createdAt}`,
      content: text,
      pubkey: overrides.pubkey ?? agent,
      createdAt,
      tags: [
        ['h', 'room'],
        ['d', 'agent-draft:room'],
        ['t', 'agent-draft'],
        ['agent', overrides.agentTag ?? overrides.pubkey ?? agent],
        ['session', overrides.sessionId ?? 'session-1'],
        ['request', overrides.requestId ?? 'request-1'],
        ...(overrides.status ? [['status', overrides.status]] : []),
      ],
    },
  };
}

describe('mobile agent draft projection', () => {
  it('projects the accumulated draft text and correlating turn ids', () => {
    expect(
      agentDraftFromSessionEvent(draft('Hello wor', 1_700_000_000), 1_700_000_000_000),
    ).toEqual({
      requestId: 'request-1',
      sessionId: 'session-1',
      agentPubkey: agent,
      text: 'Hello wor',
      observedAt: 1_700_000_000_000,
    });
  });

  it('rejects stale drafts and the terminal replacement tombstone', () => {
    const event = draft('old ghost', 1_700_000_000);
    expect(agentDraftFromSessionEvent(event, 1_700_090_001)).toBeUndefined();
    expect(
      agentDraftFromSessionEvent(draft('', 1_700_000_000, { status: 'closed' }), 1_700_000_000_000),
    ).toBeUndefined();
  });

  it('rejects a draft whose agent tag does not match the signing pubkey', () => {
    expect(
      agentDraftFromSessionEvent(draft('spoofed', 1, { agentTag: 'c'.repeat(64) })),
    ).toBeUndefined();
  });

  it('rejects an event missing the agent-draft marker tag', () => {
    const event: SessionEvent = {
      type: 'raw',
      sessionId: 'room',
      payload: {
        id: 'not-a-draft',
        content: 'hi',
        pubkey: agent,
        createdAt: 1,
        tags: [
          ['h', 'room'],
          ['agent', agent],
          ['session', 'session-1'],
          ['request', 'request-1'],
        ],
      },
    };
    expect(agentDraftFromSessionEvent(event)).toBeUndefined();
  });

  it('rejects a draft missing session or request correlation tags', () => {
    const event: SessionEvent = {
      type: 'raw',
      sessionId: 'room',
      payload: {
        id: 'incomplete',
        content: 'hi',
        pubkey: agent,
        createdAt: 1,
        tags: [
          ['h', 'room'],
          ['t', 'agent-draft'],
          ['agent', agent],
        ],
      },
    };
    expect(agentDraftFromSessionEvent(event)).toBeUndefined();
  });
});
