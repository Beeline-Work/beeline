import { describe, expect, it } from 'vitest';
import type { ReadEvent } from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import { agentDraftFromSessionEvent } from './agent-draft';

const agent = 'b'.repeat(64);

function draft(
  text: string,
  createdAt: number,
  overrides: {
    sessionId?: string;
    requestId?: string;
    status?: string;
  } = {},
): SessionEvent {
  return {
    type: 'read-model',
    sessionId: 'room',
    event: {
      type: 'session-update',
      eventId: `draft-${createdAt}`,
      authorPubkey: agent,
      createdAt,
      sourceKind: 30078,
      signature: 'verified',
      scope: 'channel',
      channelId: 'room',
      workspaceId: 'workspace',
      sessionId: overrides.sessionId ?? 'session-1',
      update: {
        kind: 'draft',
        agentPubkey: agent,
        requestId: overrides.requestId ?? 'request-1',
        text: text || undefined,
        closed: overrides.status === 'closed',
      },
    } as ReadEvent,
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

  it('rejects other typed event families', () => {
    const event: SessionEvent = {
      type: 'read-model',
      sessionId: 'room',
      event: { type: 'unknown', reason: 'unknown-schema' },
    };
    expect(agentDraftFromSessionEvent(event)).toBeUndefined();
  });
});
