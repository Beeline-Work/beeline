import { describe, expect, it, vi } from 'vitest';
import { runRoomDeckComposeAction } from './room-deck-compose-actions';

describe('Room deck compose flow wiring', () => {
  it('dispatches all five rows to the existing scoped flow', () => {
    const openMessagePicker = vi.fn();
    const openRoomCreator = vi.fn();
    const invitePerson = vi.fn();
    const navigate = vi.fn();
    const handlers = {
      communityId: 'workspace-1',
      openMessagePicker,
      openRoomCreator,
      invitePerson,
      navigate,
    };

    runRoomDeckComposeAction('message', handlers);
    runRoomDeckComposeAction('room', handlers);
    runRoomDeckComposeAction('invite', handlers);
    runRoomDeckComposeAction('agent', handlers);
    runRoomDeckComposeAction('join', handlers);

    expect(openMessagePicker).toHaveBeenCalledOnce();
    expect(openRoomCreator).toHaveBeenCalledOnce();
    expect(invitePerson).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenNthCalledWith(1, {
      pathname: '/beeline/members',
      params: { communityId: 'workspace-1', action: 'add-agent' },
    });
    expect(navigate).toHaveBeenNthCalledWith(2, {
      pathname: '/beeline/community',
      params: { mode: 'join' },
    });
  });
});
