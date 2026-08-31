import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { isRoomView } from '@beeline/api-contract/phone';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('body API contract consumer', () => {
  it('uses the same RoomView validator for prompt history reads', () => {
    expect(isRoomView({ room: { id: 'not-a-room' } })).toBe(false);
  });

  it('typechecks daemon authority and publication as named operations', () => {
    expectTypeOf<DaemonOperationMap['getPermissionAuthority']['output']>().toHaveProperty('status');
    expectTypeOf<DaemonOperationMap['postAgentTurnReceipt']['input']>().toHaveProperty('requestId');
  });
});
