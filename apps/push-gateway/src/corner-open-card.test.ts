import type { RoomViewMessage } from '@beeline/buzz-client';
import { describe, expect, it } from 'vitest';
import { collapsePermissionCards } from './room-indexer.js';

function card(
  id: string,
  createdAt: number,
  status: 'pending' | 'allowed' | 'denied',
  cornerId?: string,
): RoomViewMessage {
  return {
    id,
    text:
      status === 'allowed'
        ? 'Corner approved by @Ada — view →'
        : status === 'denied'
          ? 'Corner denied by @Ada.'
          : '@Lin asked Ox to open a corner for: repair retries',
    createdAt,
    author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Ox' },
    presentation: 'card',
    permission: {
      permissionId: 'permission-1',
      requestId: 'b'.repeat(64),
      agent: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Ox' },
      requester: { pubkey: 'c'.repeat(64), kind: 'human', name: 'Lin' },
      ...(status === 'pending'
        ? {}
        : { decider: { pubkey: 'd'.repeat(64), kind: 'human' as const, name: 'Ada' } }),
      tool: 'open_corner',
      repository: 'lunchboxfortwo/beeline',
      status,
      ...(cornerId ? { cornerId } : {}),
    },
  };
}

describe('corner-open approval card projection', () => {
  it('mutates one pending card into the approved linked outcome', () => {
    const result = collapsePermissionCards([
      card('1'.repeat(64), 1, 'pending'),
      card('2'.repeat(64), 2, 'allowed', '11111111-1111-4111-8111-111111111111'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      text: 'Corner approved by @Ada — view →',
      permission: {
        status: 'allowed',
        cornerId: '11111111-1111-4111-8111-111111111111',
        decider: { name: 'Ada' },
      },
    });
  });

  it('mutates one pending card into the denied outcome', () => {
    const result = collapsePermissionCards([
      card('1'.repeat(64), 1, 'pending'),
      card('2'.repeat(64), 2, 'denied'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      text: 'Corner denied by @Ada.',
      permission: { status: 'denied', decider: { name: 'Ada' } },
    });
  });
});
