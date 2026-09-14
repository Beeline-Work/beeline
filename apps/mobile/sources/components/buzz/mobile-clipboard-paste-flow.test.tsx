import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

// Same host-element mocking convention as ConversationComposer.test.tsx and
// AttachmentPickerSheet.test.ts: render real component logic, stub the leaf
// native/branded primitives as tagged host elements we can query by testID.
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
// The composer renders MicGlyph, which imports react-native-svg. Stub it the
// same way ConversationComposer.test.tsx does — the real package ships
// untranspiled sources that vite cannot parse under this config.
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  const Svg = host('RNSVG');
  return { default: Svg, Svg, Line: host('RNSVGLine') };
});

// chat-attachment.ts's non-clipboard imports, stubbed the same way
// chat-attachment.test.ts stubs them — they're not exercised by this path.
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: {} }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: vi.fn() }));

const clipboard = vi.hoisted(() => ({
  hasImageAsync: vi.fn(),
  getImageAsync: vi.fn(),
}));
vi.mock('expo-clipboard', () => clipboard);

const fileSystem = vi.hoisted(() => ({ writeAsStringAsync: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({
  writeAsStringAsync: fileSystem.writeAsStringAsync,
  EncodingType: { Base64: 'base64' },
  cacheDirectory: 'file:///cache/',
}));

import { COMPOSER_SINGLE_LINE_INPUT_HEIGHT, ConversationComposer } from './ConversationComposer';
import { AttachmentPickerSheet } from './AttachmentPickerSheet';
import { formatAttachmentSize, pastedImageAttachment, type PickedChatAttachment } from '@/buzz/chat-attachment';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Mirrors the composer wiring in [channelId].tsx: the screen owns pendingAttachments and calls the real paste pipeline, exactly as pickPhoto does for the photo library. */
function ComposerWithClipboardPaste() {
  const [pendingAttachments, setPendingAttachments] = React.useState<PickedChatAttachment[]>([]);
  const [attachmentPickerVisible, setAttachmentPickerVisible] = React.useState(false);

  const pasteImage = React.useCallback(async () => {
    if (!(await clipboard.hasImageAsync())) return;
    const image = await clipboard.getImageAsync({ format: 'png' });
    if (!image) return;
    const attachment = await pastedImageAttachment(image);
    setPendingAttachments((current) => [...current, attachment]);
  }, []);

  return (
    <>
      <ConversationComposer
        value=""
        height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
        focused={false}
        disabled={false}
        onAttach={() => setAttachmentPickerVisible(true)}
        attachments={pendingAttachments.map((attachment) => ({
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
        onSend={() => {}}
      />
      <AttachmentPickerSheet
        visible={attachmentPickerVisible}
        onClose={() => setAttachmentPickerVisible(false)}
        onPickDocument={() => {}}
        onPickPhoto={() => {}}
        onPickPasted={() => void pasteImage()}
      />
    </>
  );
}

describe('a person on iOS/Android pastes a copied image into the composer', () => {
  it('taps Attach, taps Paste Image, and sees the clipboard image appear as a pending attachment', async () => {
    const base64 = Buffer.from('screenshot-bytes').toString('base64');
    clipboard.hasImageAsync.mockResolvedValue(true);
    clipboard.getImageAsync.mockResolvedValue({
      data: `data:image/png;base64,${base64}`,
      size: { width: 400, height: 300 },
    });

    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(ComposerWithClipboardPaste));
    });

    // Nothing pasted yet: no pending attachment is shown.
    expect(renderer!.root.findAllByProps({ testID: 'pending-chat-attachment-0' })).toHaveLength(0);

    // Tap the composer's "+" attach button — the same entry point pickPhoto/pickDocument use.
    act(() => renderer!.root.findByProps({ testID: 'chat-attach-button' }).props.onPress());

    // The sheet now offers "Paste Image" alongside Photos/Document.
    const pasteRow = renderer!.root.findByProps({ testID: 'attachment-picker-paste' });
    expect(pasteRow.props.label).toBe('Paste Image');

    // Tap it — this drives the real getImageAsync -> pastedImageAttachment pipeline.
    await act(async () => {
      pasteRow.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clipboard.getImageAsync).toHaveBeenCalledWith({ format: 'png' });
    expect(fileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      expect.stringContaining('file:///cache/pasted-'),
      base64,
      { encoding: 'base64' },
    );

    // The observable Y: the pasted image now renders as a pending attachment in the composer.
    expect(
      renderer!.root.findAllByProps({ testID: 'pending-chat-attachment-1' }),
    ).toHaveLength(0);
    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain('pending-chat-attachment-0');
    expect(rendered).toContain('pasted-');
    expect(rendered).toContain('.png');
    expect(rendered).toContain('IMAGE/PNG');
  });
});
