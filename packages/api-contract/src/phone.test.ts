import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createCommunityInviteToken,
  isCommunityInviteToken,
  isRoomView,
  isWorkspaceListView,
  type PhoneOperationMap,
} from './phone.js';

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
    expectTypeOf<PhoneOperationMap['sendRoomMessage']['input']>().toHaveProperty('messageId');
    expectTypeOf<PhoneOperationMap['addWorkspaceMember']['input']>().toHaveProperty('role');
  });

  it('owns the canonical invite-token format while accepting pre-contract monolith tokens', () => {
    const token = createCommunityInviteToken(Uint8Array.from({ length: 32 }, (_, index) => index));
    expect(token).toBe('bzi_000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    expect(isCommunityInviteToken(token)).toBe(true);
    expect(isCommunityInviteToken(`bzi_${'A'.repeat(42)}_`)).toBe(true);
    expect(isCommunityInviteToken(`bzi_${'a'.repeat(63)}`)).toBe(false);
  });
});
