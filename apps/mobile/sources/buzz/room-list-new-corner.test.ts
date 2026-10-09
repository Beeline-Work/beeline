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

import { MONOLITH_REQUEST_TIMEOUT_MS, MonolithRequestTimeoutError } from '@/auth/monolith-session';
import { openRoomListCorner } from './room-list-new-corner';
import {
  CORNER_OPEN_DEADLINE_SECONDS,
  cornerOpenEnded,
  cornerOpenStatus,
} from './corner-open-status';

describe('openRoomListCorner', () => {
  beforeEach(() => {
    alert.mockClear();
    cornerOpenEnded();
  });

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
    expect(alert).not.toHaveBeenCalled();
    const status = cornerOpenStatus();
    expect(status).toMatchObject({
      status: 'failed',
      roomId: 'room-a',
      timedOut: failure instanceof MonolithRequestTimeoutError,
    });
    if (status.status !== 'failed') throw new Error('unreachable');
    status.retry();
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
    expect(cornerOpenStatus()).toEqual({ status: 'idle' });
  });

  it('names the same deadline the create request runs under', () => {
    expect(CORNER_OPEN_DEADLINE_SECONDS * 1000).toBe(MONOLITH_REQUEST_TIMEOUT_MS);
  });

  it('shows the create as pending while the request is in flight', async () => {
    let answer!: (id: string) => void;
    const pending = openRoomListCorner({
      roomId: 'room-a',
      createCorner: () => new Promise<string>((resolve) => (answer = resolve)),
      openCorner: vi.fn(),
      retry: vi.fn(),
    });
    expect(cornerOpenStatus()).toMatchObject({ status: 'pending', roomId: 'room-a', again: false });
    answer('corner-new');
    await pending;
    expect(cornerOpenStatus()).toEqual({ status: 'idle' });
  });
});
