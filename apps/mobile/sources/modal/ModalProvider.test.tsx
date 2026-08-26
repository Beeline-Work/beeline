import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./components/WebAlertModal', async () => {
  const ReactModule = await import('react');
  return {
    WebAlertModal: (props: any) => ReactModule.createElement('WebAlertModal', props),
  };
});

vi.mock('./components/WebPromptModal', async () => {
  const ReactModule = await import('react');
  return {
    WebPromptModal: (props: any) => ReactModule.createElement('WebPromptModal', props),
  };
});

vi.mock('./components/CustomModal', async () => {
  const ReactModule = await import('react');
  return { CustomModal: (props: any) => ReactModule.createElement('CustomModal', props) };
});

vi.mock('@/components/buzz/HullActionSheet', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullActionSheetCancel: host('HullActionSheetCancel'),
    HullActionSheetModal: host('HullActionSheetModal'),
    HullActionSheetRow: host('HullActionSheetRow'),
  };
});

vi.mock('@/text', () => ({ t: () => 'OK' }));

import { Modal } from './ModalManager';
import { ModalProvider } from './ModalProvider';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

async function renderProvider(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ModalProvider>
        <Child />
      </ModalProvider>,
    );
  });
  return renderer;
}

function Child() {
  return React.createElement('Child');
}

describe('ModalProvider Hull integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders only the top request and resolves platform-back cancellation before revealing the prior alert', async () => {
    const renderer = await renderProvider();
    let confirmation!: Promise<boolean>;

    await act(async () => {
      Modal.alert('First notice', 'Still queued');
      confirmation = Modal.confirm('Leave?', 'You can return later.', {
        cancelText: 'Cancel',
        confirmText: 'Leave',
        destructive: true,
      });
    });

    const confirm = renderer.root.findByType('WebAlertModal' as any);
    expect(confirm.props.config).toMatchObject({ title: 'Leave?', type: 'confirm' });
    await act(async () => confirm.props.onClose());
    await expect(confirmation).resolves.toBe(false);
    expect(renderer.root.findByType('WebAlertModal' as any).props.config).toMatchObject({
      title: 'First notice',
      type: 'alert',
    });
  });

  it('resolves prompt text and removes the input surface', async () => {
    const renderer = await renderProvider();
    let prompt!: Promise<string | null>;

    await act(async () => {
      prompt = Modal.prompt('New Room', 'In Night Shift.', {
        confirmText: 'Create',
        defaultValue: 'ledger',
      });
    });

    const input = renderer.root.findByType('WebPromptModal' as any);
    await act(async () => input.props.onConfirm('ledger-room'));
    await expect(prompt).resolves.toBe('ledger-room');
    expect(renderer.root.findAllByType('WebPromptModal' as any)).toHaveLength(0);
  });

  it('closes an action sheet before dispatching the selected callback and supports quiet cancellation', async () => {
    const renderer = await renderProvider();
    const selected = vi.fn();

    await act(async () => {
      Modal.actionSheet(
        'Room',
        [{ text: 'Copy ID', disabled: false, metadata: 'room-123', onPress: selected }],
        { cancelText: 'Cancel', message: 'Room details' },
      );
    });

    const sheet = renderer.root.findByType('HullActionSheetModal' as any);
    expect(sheet.props).toMatchObject({ subtitle: 'Room details', title: 'Room', visible: true });
    const row = renderer.root.findByType('HullActionSheetRow' as any);
    expect(row.props).toMatchObject({ disabled: false, label: 'Copy ID', metadata: 'room-123' });
    await act(async () => row.props.onPress());
    expect(selected).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByType('HullActionSheetModal' as any)).toHaveLength(0);

    await act(async () => {
      Modal.actionSheet('Room', [{ text: 'Copy ID', onPress: selected }]);
    });
    await act(async () => renderer.root.findByType('HullActionSheetCancel' as any).props.onPress());
    expect(selected).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByType('HullActionSheetModal' as any)).toHaveLength(0);
  });
});
