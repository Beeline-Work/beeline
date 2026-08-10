import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@beeline/nostr';
import { mapEventToNotification } from './mapping.js';

function event(tags: string[][], content = 'plaintext that must not escape'): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1,
    kind: 9,
    tags,
    content,
    sig: 'c'.repeat(128),
  };
}

describe('mapEventToNotification', () => {
  it('maps a channel message without leaking event plaintext', () => {
    const result = mapEventToNotification(event([['h', 'channel-123']]), 'Demo channel');

    expect(result).toEqual({
      channelId: 'channel-123',
      title: 'New Buzzy activity',
      body: 'New activity in Demo channel',
      data: { channelId: 'channel-123', type: 'channel-activity' },
    });
    expect(JSON.stringify(result)).not.toContain('plaintext');
  });

  it('maps body merge metadata to an approval request', () => {
    const result = mapEventToNotification(event([
      ['h', 'channel-123'],
      ['t', 'body-control'],
      ['repo', 'owner/repo'],
      ['branch', 'feature/push'],
      ['tip', 'd'.repeat(40)],
    ]), 'Push work');

    expect(result?.title).toBe('Merge approval requested');
    expect(result?.body).toBe('Review requested in Push work');
    expect(result?.data.type).toBe('merge-approval-request');
  });

  it('ignores activity frames, approval grants, and non-request control events', () => {
    expect(mapEventToNotification(event([['h', 'c'], ['t', 'agent-activity']]))).toBeNull();
    expect(mapEventToNotification(event([['h', 'c'], ['t', 'buzz-merge-approval']]))).toBeNull();
    expect(mapEventToNotification(event([['h', 'c'], ['t', 'body-control']]))).toBeNull();
  });

  it('ignores events without a channel', () => {
    expect(mapEventToNotification(event([]))).toBeNull();
  });
});
