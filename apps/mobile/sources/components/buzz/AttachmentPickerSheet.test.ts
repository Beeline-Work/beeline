import { readFileSync } from 'node:fs';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const desktop = vi.hoisted(() => ({ value: false }));

vi.mock('@/utils/responsive', () => ({
  useIsDesktop: () => desktop.value,
}));

vi.mock('./HullActionSheet', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullActionSheetCancel: host('HullActionSheetCancel'),
    HullActionSheetModal: host('HullActionSheetModal'),
    HullActionSheetRow: host('HullActionSheetRow'),
  };
});

vi.mock('./HullDialog', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { HullDialog: host('HullDialog') };
});

const { AttachmentPickerSheet } = await import('./AttachmentPickerSheet');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const source = readFileSync(new URL('./AttachmentPickerSheet.tsx', import.meta.url), 'utf8');
const chatSource = readFileSync(
  new URL('../../app/(app)/beeline/chat/[channelId].tsx', import.meta.url),
  'utf8',
);

afterEach(() => {
  desktop.value = false;
});

describe('AttachmentPickerSheet', () => {
  it('presents photo and document choices in the branded bottom sheet', () => {
    expect(source).toContain('testID="attachment-picker-sheet"');
    expect(source).toContain('testID="attachment-picker-photo"');
    expect(source).toContain('testID="attachment-picker-document"');
    expect(source).toContain('<HullActionSheetModal');
    expect(source).toContain('<HullActionSheetCancel');
    expect(source).toContain('label="Photos"');
    expect(source).toContain('metadata="Choose up to 10"');
  });

  it('uses the centered Hull dialog only at the desktop breakpoint', () => {
    desktop.value = true;
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(AttachmentPickerSheet, {
          visible: true,
          onClose: vi.fn(),
          onPickDocument: vi.fn(),
          onPickPhoto: vi.fn(),
        }),
      );
    });

    expect(renderer!.root.findByType('HullDialog' as any).props).toMatchObject({
      title: 'Attach',
      visible: true,
    });
    expect(renderer!.root.findAllByType('HullActionSheetModal' as any)).toHaveLength(0);
  });

  it('replaces the composer attachment alert while preserving both picker actions', () => {
    expect(chatSource).toContain('<AttachmentPickerSheet');
    expect(chatSource).toContain('onPickDocument={() => void pickDocument()}');
    expect(chatSource).toContain('onPickPhoto={() => void pickPhoto()}');
    expect(chatSource).not.toContain("Alert.alert('Attach to message'");
  });

  it('selects and renders multiple photos for one Room or corner message', () => {
    expect(chatSource).toContain('allowsMultipleSelection: true');
    expect(chatSource).toContain('selectionLimit: remaining');
    expect(chatSource).toContain('pickedPhotoAttachments(result.assets)');
    expect(chatSource).toContain('pendingAttachments.map((attachment, index) =>');
    expect(chatSource).toContain('uploadChatAttachments(');
    expect(chatSource).toContain('testID={`pending-chat-attachment-remove-${index}`}');
  });

  it('closes before dispatching Photo or Document and exposes scrim/Cancel dismissal', () => {
    const calls: string[] = [];
    const onClose = vi.fn(() => calls.push('close'));
    const onPickDocument = vi.fn(() => calls.push('document'));
    const onPickPhoto = vi.fn(() => calls.push('photo'));
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(AttachmentPickerSheet, {
          visible: true,
          onClose,
          onPickDocument,
          onPickPhoto,
        }),
      );
    });

    const rows = renderer!.root.findAllByType('HullActionSheetRow' as any);
    act(() => rows[0].props.onPress());
    act(() => rows[1].props.onPress());
    expect(calls).toEqual(['close', 'photo', 'close', 'document']);

    const sheet = renderer!.root.findByType('HullActionSheetModal' as any);
    expect(sheet.props).toMatchObject({
      accessibilityLabel: 'Close attachment picker',
      scrimTestID: 'attachment-picker-scrim',
      visible: true,
    });
    act(() => sheet.props.onClose());
    act(() => renderer!.root.findByType('HullActionSheetCancel' as any).props.onPress());
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});
