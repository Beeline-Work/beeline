import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({ t: () => 'OK' }));

import { Modal } from './ModalManager';
import type { ModalConfig } from './types';

describe('ModalManager Hull requests', () => {
  const shown: Array<Omit<ModalConfig, 'id'>> = [];

  beforeEach(() => {
    shown.length = 0;
    Modal.setFunctions(
      (config) => {
        shown.push(config);
        return `modal-${shown.length}`;
      },
      vi.fn(),
      vi.fn(),
    );
  });

  it('preserves alert and bottom-sheet action metadata and semantics', () => {
    const copy = vi.fn();
    Modal.alert('Offline', 'Try again later', [{ text: 'OK', style: 'cancel' }]);
    Modal.actionSheet('Room', [{ text: 'Copy Room ID', metadata: 'room-123', onPress: copy }], {
      cancelText: 'Cancel',
      message: 'Room details',
    });

    expect(shown[0]).toEqual({
      type: 'alert',
      title: 'Offline',
      message: 'Try again later',
      buttons: [{ text: 'OK', style: 'cancel' }],
    });
    expect(shown[1]).toMatchObject({
      type: 'action-sheet',
      title: 'Room',
      message: 'Room details',
      cancelText: 'Cancel',
    });
    expect((shown[1] as Extract<ModalConfig, { type: 'action-sheet' }>).actions[0]).toMatchObject({
      text: 'Copy Room ID',
      metadata: 'room-123',
    });
  });

  it('resolves destructive confirmation and input results through the shared provider boundary', async () => {
    const confirmation = Modal.confirm('Leave?', 'You can be invited again.', {
      cancelText: 'Cancel',
      confirmText: 'Leave',
      destructive: true,
    });
    expect(shown[0]).toMatchObject({ type: 'confirm', destructive: true, confirmText: 'Leave' });
    Modal.resolveConfirm('modal-1', true);
    await expect(confirmation).resolves.toBe(true);

    const input = Modal.prompt('New Room', 'In Workspace.', {
      placeholder: 'Room name',
      confirmText: 'Create',
    });
    expect(shown[1]).toMatchObject({
      type: 'prompt',
      placeholder: 'Room name',
      confirmText: 'Create',
    });
    Modal.resolvePrompt('modal-2', 'night-shift');
    await expect(input).resolves.toBe('night-shift');
  });
});
