import { isWorkspaceListView, type PhoneOperationMap } from '@beeline/api-contract/phone';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('mobile API contract consumer', () => {
  it('rejects an unvalidated workspace surface before mobile paint', () => {
    expect(
      isWorkspaceListView({
        workspaces: [],
        viewer: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
        truncated: false,
        watchFilters: [],
      }),
    ).toBe(true);
    expect(isWorkspaceListView({ workspaces: [], viewer: null })).toBe(false);
  });

  it('typechecks mobile writes against named operations', () => {
    expectTypeOf<PhoneOperationMap['sendRoomMessage']['input']>().toHaveProperty('roomId');
    expectTypeOf<PhoneOperationMap['registerPushDevice']['input']>().toHaveProperty('token');
  });
});
