import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { confirm } }));

import { leaveRoomWithConfirmation } from './room-leave';

describe('Room leave confirmation', () => {
  beforeEach(() => confirm.mockReset());

  it('leaves an ordinary Room without delete authority', async () => {
    confirm.mockResolvedValue(true);
    const leave = vi.fn().mockResolvedValue(undefined);
    expect(await leaveRoomWithConfirmation('#Garden', false, leave)).toBe(true);
    expect(confirm).toHaveBeenCalledWith('Leave #Garden?', 'Other members keep their access.', {
      cancelText: 'Cancel',
      confirmText: 'Leave',
      destructive: true,
    });
    expect(leave).toHaveBeenCalledWith(false);
  });

  it('names the deletion before confirming the last admin leave', async () => {
    confirm.mockResolvedValue(true);
    const leave = vi.fn().mockResolvedValue(undefined);
    expect(await leaveRoomWithConfirmation('#Garden', true, leave)).toBe(true);
    expect(confirm).toHaveBeenCalledWith(
      'Leave #Garden?',
      "You're the last admin in #Garden. Leaving deletes it for everyone.",
      { cancelText: 'Cancel', confirmText: 'Leave and delete', destructive: true },
    );
    expect(leave).toHaveBeenCalledWith(true);
  });

  it('asks again when another admin left after the view was read', async () => {
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const leave = vi.fn().mockRejectedValueOnce(new Error('last_admin_confirmation_required'));
    expect(await leaveRoomWithConfirmation('#Garden', false, leave)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
