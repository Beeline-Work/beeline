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

import { MonolithRequestTimeoutError } from '@/auth/monolith-session';
import { openRoomListCorner } from './room-list-new-corner';

describe('openRoomListCorner', () => {
  beforeEach(() => alert.mockClear());

  it('creates a named human corner in the Room and opens it', async () => {
    const createCorner = vi.fn(async () => 'corner-new');
    const openCorner = vi.fn();
    await openRoomListCorner({ roomId: 'room-a', createCorner, openCorner, retry: vi.fn() });

    const [, title, cornerId] = createCorner.mock.calls[0] as unknown as [string, string, string];
    expect(createCorner).toHaveBeenCalledWith('room-a', title, cornerId);
    expect(cornerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(title).toMatch(/^\w+-\w+-corner$/);
    expect(openCorner).toHaveBeenCalledWith('corner-new', title);
    expect(alert).not.toHaveBeenCalled();
  });

  it('explains itself instead of doing nothing before the transport exists', async () => {
    const openCorner = vi.fn();
    await openRoomListCorner({ roomId: 'room-a', createCorner: null, openCorner, retry: vi.fn() });

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
      retry: vi.fn(),
    });

    expect(openCorner).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith('Could not open corner', 'forbidden');
  });

  it.each([
    ['times out', new MonolithRequestTimeoutError()],
    ['loses the network', new TypeError('Network request failed')],
  ])('offers Retry with the same corner id when the request %s', async (_, failure) => {
    const createCorner = vi.fn(async (): Promise<string> => {
      throw failure;
    });
    const retry = vi.fn();
    const openCorner = vi.fn();
    await openRoomListCorner({ roomId: 'room-a', createCorner, openCorner, retry });

    expect(openCorner).not.toHaveBeenCalled();
    const [heading, , buttons] = alert.mock.calls[0] as [
      string,
      string,
      { text: string; onPress?: () => void }[],
    ];
    expect(heading).toBe("Couldn't reach Beeline");
    expect(buttons.map((button) => button.text)).toEqual(['Cancel', 'Retry']);
    buttons[1]!.onPress!();
    const [, title, cornerId] = createCorner.mock.calls[0] as unknown as [string, string, string];
    expect(retry).toHaveBeenCalledWith({ title, cornerId });

    // The retried attempt asks the server for that same corner.
    createCorner.mockResolvedValueOnce('corner-new');
    await openRoomListCorner({
      roomId: 'room-a',
      createCorner,
      openCorner,
      retry,
      attempt: retry.mock.calls[0]![0],
    });
    expect(createCorner).toHaveBeenLastCalledWith('room-a', title, cornerId);
    expect(openCorner).toHaveBeenCalledWith('corner-new', title);
  });
});
