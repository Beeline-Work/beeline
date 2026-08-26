import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/buzz/HullDialog', async () => {
  const ReactModule = await import('react');
  return { HullDialog: (props: any) => ReactModule.createElement('HullDialog', props) };
});

import { WebAlertModal } from './WebAlertModal';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe('Hull alert and confirm adapter', () => {
  it('keeps ordinary alerts non-dismissible outside their actions and preserves button callbacks', () => {
    const close = vi.fn();
    const acknowledge = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <WebAlertModal
          config={{
            buttons: [{ text: 'Continue', onPress: acknowledge }],
            id: 'alert-1',
            message: 'Connected.',
            title: 'Ready',
            type: 'alert',
          }}
          onClose={close}
        />,
      );
    });
    const dialog = renderer!.root.findByType('HullDialog' as any);

    expect(dialog.props.dismissOnBackdrop).toBe(false);
    act(() => dialog.props.actions[0].onPress());
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps cancel, brass confirm, destructive confirm, and platform back to boolean results', () => {
    const onConfirm = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <WebAlertModal
          config={{
            cancelText: 'Cancel',
            confirmText: 'Leave',
            destructive: true,
            id: 'confirm-1',
            title: 'Leave Room?',
            type: 'confirm',
          }}
          onClose={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
    });
    const dialog = renderer!.root.findByType('HullDialog' as any);

    expect(dialog.props.actions.map((action: any) => action.variant)).toEqual([
      'quiet',
      'destructive',
    ]);
    act(() => dialog.props.actions[0].onPress());
    act(() => dialog.props.actions[1].onPress());
    act(() => dialog.props.onRequestClose());
    expect(onConfirm.mock.calls).toEqual([[false], [true], [false]]);
  });
});
