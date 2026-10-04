import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

// Same host-element mocking convention as mobile-clipboard-paste-flow.test.tsx:
// real composer, picker and uploader logic; leaf native primitives as tagged hosts.
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Text: host('Text'),
    View: host('View'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    Pressable: host('Pressable'),
    Platform: { OS: 'ios', select: (choices: any) => choices.ios ?? choices.default },
  };
});
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
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
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  const Svg = host('RNSVG');
  return { default: Svg, Svg, Line: host('RNSVGLine') };
});
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: {} }));
vi.mock('expo-clipboard', () => ({}));
vi.mock('expo-file-system/legacy', () => ({}));
vi.mock('@/utils/readFileBytes', () => ({
  readFileBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

import { COMPOSER_SINGLE_LINE_INPUT_HEIGHT, ConversationComposer } from './ConversationComposer';
import { AttachmentPickerSheet } from './AttachmentPickerSheet';
import {
  createChatAttachmentUploader,
  formatAttachmentSize,
  type PickedChatAttachment,
} from '@/buzz/chat-attachment';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const uploadMedia = vi.fn(async () => ({
  url: 'https://usebeeline.app/v1/media/report',
  sha256: 'report-hash',
  size: 3,
  type: 'application/pdf',
}));
const client = { uploadMedia } as never;
const sent: unknown[] = [];

/** Mirrors the chat surface: staged files upload as they land, send reuses those uploads. */
function ComposerWithFiles() {
  const [pending, setPending] = React.useState<PickedChatAttachment[]>([]);
  const [pickerVisible, setPickerVisible] = React.useState(false);
  const [uploader] = React.useState(createChatAttachmentUploader);
  React.useEffect(() => {
    uploader.retain(pending);
    uploader.start(client, pending);
  }, [pending, uploader]);
  return (
    <>
      <ConversationComposer
        value=""
        canSend={pending.length > 0}
        height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
        focused={false}
        disabled={false}
        onAttach={() => setPickerVisible(true)}
        attachments={pending.map((attachment) => ({
          uri: attachment.uri,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeLabel: formatAttachmentSize(attachment.size),
        }))}
        onBlur={() => {}}
        onChangeText={() => {}}
        onContentSizeChange={() => {}}
        onFocus={() => {}}
        onKeyPress={() => {}}
        onSend={() =>
          void uploader.uploadAll(client, pending).then((attachments) => {
            sent.push(...attachments);
            setPending([]);
          })
        }
      />
      <AttachmentPickerSheet
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onPickDocument={() =>
          setPending((current) => [
            ...current,
            {
              uri: 'file:///cache/report.pdf',
              name: 'report.pdf',
              mimeType: 'application/pdf',
              size: 3,
              source: 'file',
            },
          ])
        }
        onPickPhoto={() => {}}
        onPickPasted={() => {}}
      />
    </>
  );
}

describe('a person attaches a file in the composer', () => {
  it('sees Files and Paste from clipboard, and the file uploads before they press send', async () => {
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(ComposerWithFiles));
    });

    act(() => renderer!.root.findByProps({ testID: 'chat-attach-button' }).props.onPress());
    const labels = renderer!.root
      .findAllByType('HullActionSheetRow' as any)
      .map((row: any) => row.props.label);
    console.log('+ menu rows:', labels.join(' | '));
    expect(labels).toEqual(['Photos', 'Files', 'Paste from clipboard']);

    act(() => renderer!.root.findByProps({ testID: 'attachment-picker-document' }).props.onPress());
    expect(uploadMedia).not.toHaveBeenCalled();
    act(() => renderer!.root.findByType('HullActionSheetModal' as any).props.onDismiss());
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    console.log(`staged report.pdf; uploads before send: ${uploadMedia.mock.calls.length}`);
    expect(sent).toEqual([]);

    await act(async () => {
      renderer!.root.findByProps({ testID: 'chat-send' }).props.onPress();
      await vi.waitFor(() => expect(sent).toHaveLength(1));
    });
    console.log(
      `sent ${JSON.stringify(sent)}; total uploads after send: ${uploadMedia.mock.calls.length}`,
    );
    expect(sent).toEqual([expect.objectContaining({ name: 'report.pdf' })]);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });
});
