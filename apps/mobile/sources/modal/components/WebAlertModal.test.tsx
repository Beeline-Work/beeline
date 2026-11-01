import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/buzz/HullDialog', async () => {
  const ReactModule = await import('react');
  return { HullDialog: (props: any) => ReactModule.createElement('HullDialog', props) };
});

vi.mock('@/components/buzz/HullActionSheet', () => ({ HullActionSheetCancel: () => null, HullActionSheetModal: () => null, HullActionSheetRow: () => null }));
vi.mock('./WebPromptModal', () => ({ WebPromptModal: () => null }));
vi.mock('./CustomModal', () => ({ CustomModal: () => null }));
import { Modal } from '../ModalManager';
import { ModalProvider } from '../ModalProvider';
import { WebAlertModal } from './WebAlertModal';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('Hull alert and confirm adapter', () => {
  it('dismisses the mounted confirmation after one successful remove press', async () => {
    let finish!: () => void;
    const remove = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(<ModalProvider><></></ModalProvider>); });
    let confirmation!: Promise<boolean>;
    act(() => { confirmation = Modal.confirm('Remove Claude?', 'Remove this Room membership.',
      { confirmText: 'Remove', pendingText: 'Removing…', onConfirm: remove }); });
    const dialog = () => renderer!.root.findByType('HullDialog' as any);
    act(() => dialog().props.actions[1].onPress());
    expect(dialog().props.actions[1].loading).toBe(true);
    await act(async () => finish());
    await expect(confirmation).resolves.toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(renderer!.root.findAllByType('HullDialog' as any)).toHaveLength(0);
    act(() => renderer!.unmount());
  });

  it('runs removal once, shows progress and closes after the request completes', async () => {
    let finish!: () => void;
    const remove = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const close = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(<WebAlertModal config={{ id: 'remove', type: 'confirm',
      title: 'Remove Claude?', confirmText: 'Remove', pendingText: 'Removing…', onConfirm: remove }}
      onClose={vi.fn()} onConfirm={close} />); });
    const dialog = () => renderer!.root.findByType('HullDialog' as any);
    const press = dialog().props.actions[1].onPress;
    act(() => { press(); press(); });
    expect(remove).toHaveBeenCalledOnce();
    expect(dialog().props.actions[1]).toMatchObject({ label: 'Removing…', loading: true, disabled: true });
    act(() => dialog().props.onRequestClose());
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('keeps a failed removal open with an error and permits one retry', async () => {
    const remove = vi.fn().mockRejectedValueOnce(new Error('Could not remove Claude. Offline.')).mockResolvedValueOnce(undefined);
    const close = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(<WebAlertModal config={{ id: 'remove', type: 'confirm',
      title: 'Remove Claude?', confirmText: 'Remove', onConfirm: remove }} onClose={vi.fn()} onConfirm={close} />); });
    const dialog = () => renderer!.root.findByType('HullDialog' as any);
    await act(async () => dialog().props.actions[1].onPress());
    expect(close).not.toHaveBeenCalled();
    expect(dialog().props.body).toContain('Could not remove Claude. Offline.');
    expect(dialog().props.actions[1]).toMatchObject({ label: 'Remove', disabled: false });
    await act(async () => dialog().props.actions[1].onPress());
    expect(remove).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
  });

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
            message: 'This removes the agent from every Room and the Workspace.',
            title: 'Leave Room?',
            type: 'confirm',
          }}
          onClose={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
    });
    const dialog = renderer!.root.findByType('HullDialog' as any);

    expect(dialog.props).toMatchObject({
      body: 'This removes the agent from every Room and the Workspace.',
      dismissOnBackdrop: true,
      scrimTestID: 'hull-confirm-dismiss',
      title: 'Leave Room?',
    });
    expect(dialog.props.actions.map((action: any) => action.testID)).toEqual([
      'hull-confirm-cancel',
      'hull-confirm-submit',
    ]);
    expect(dialog.props.actions.map((action: any) => action.variant)).toEqual([
      'quiet',
      'destructive',
    ]);
    act(() => dialog.props.actions[0].onPress());
    act(() => dialog.props.actions[1].onPress());
    act(() => dialog.props.onRequestClose());
    expect(onConfirm.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('maps a non-destructive confirm to one quiet action and one brass affirmative action', () => {
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <WebAlertModal
          config={{
            cancelText: 'Not now',
            confirmText: 'Continue',
            id: 'confirm-2',
            title: 'Continue?',
            type: 'confirm',
          }}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
    });
    const actions = renderer!.root.findByType('HullDialog' as any).props.actions;
    expect(actions.map((action: any) => action.variant)).toEqual(['quiet', 'primary']);
    expect(actions.filter((action: any) => action.variant === 'primary')).toHaveLength(1);
  });
});
