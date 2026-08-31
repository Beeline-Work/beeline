import { describe, expect, expectTypeOf, it } from 'vitest';
import { isRoomView, isWorkspaceListView, type PhoneOperationMap } from './phone.js';

const identity = { pubkey: 'a'.repeat(64), kind: 'human' as const, name: 'Owner' };

describe('phone contract', () => {
  it('validates extracted RoomView responses and rejects malformed nested state', () => {
    const room = {
      room: {
        id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        workspaceId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
        name: 'Launch',
        archived: false,
        createdAt: 1,
        updatedAt: 2,
      },
      messages: [],
      members: [],
      latestAgentTurns: [],
      corners: [],
      repositoryResolution: 'none',
      viewer: { identity, role: 'owner', permissions: { send: true, manage: true } },
      watchFilters: [],
    };
    expect(isRoomView(room)).toBe(true);
    expect(isRoomView({ ...room, latestAgentTurns: [{ status: 'working' }] })).toBe(false);
  });

  it('keeps list guards and named operations type-visible', () => {
    expect(
      isWorkspaceListView({ workspaces: [], viewer: identity, truncated: false, watchFilters: [] }),
    ).toBe(true);
    expectTypeOf<PhoneOperationMap['uploadMedia']['output']>().toHaveProperty('url');
  });
});
