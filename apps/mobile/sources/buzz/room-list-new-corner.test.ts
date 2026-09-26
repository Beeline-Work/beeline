import { beforeEach, describe, expect, it, vi } from 'vitest';

const alert = vi.hoisted(() => vi.fn());
vi.mock('@/modal', () => ({ Modal: { alert } }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
vi.mock('@/sync/transport/monolith-operation', () => ({
  phoneOperationFailureReason: (err: unknown) => (err as Error).message,
}));

import { openRoomListCorner } from './room-list-new-corner';

describe('openRoomListCorner', () => {
  beforeEach(() => alert.mockClear());

  it('creates a named human corner in the Room and opens it', async () => {
    const createCorner = vi.fn(async () => 'corner-new');
    const openCorner = vi.fn();
    await openRoomListCorner({ roomId: 'room-a', createCorner, openCorner });

    const [, title] = createCorner.mock.calls[0] as unknown as [string, string];
    expect(createCorner).toHaveBeenCalledWith('room-a', title);
    expect(title).toMatch(/^\w+ \w+ corner$/);
    expect(openCorner).toHaveBeenCalledWith('corner-new', title);
    expect(alert).not.toHaveBeenCalled();
  });

  it('explains itself instead of doing nothing before the transport exists', async () => {
    const openCorner = vi.fn();
    await openRoomListCorner({ roomId: 'room-a', createCorner: null, openCorner });

    expect(openCorner).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith('Not connected yet', expect.stringContaining('corner'));
  });

  it('names a refused create and opens nothing', async () => {
    const openCorner = vi.fn();
    await openRoomListCorner({
      roomId: 'room-a',
      createCorner: async () => {
        throw new Error('forbidden');
      },
      openCorner,
    });

    expect(openCorner).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith('Could not open corner', 'forbidden');
  });
});
