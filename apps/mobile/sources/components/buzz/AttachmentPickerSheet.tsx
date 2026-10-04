import React from 'react';
import { Platform } from 'react-native';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';
import { HullDialog } from './HullDialog';
import { useIsDesktop } from '@/utils/responsive';

type AttachmentPickerSheetProps = {
  visible: boolean;
  onClose: () => void;
  onPickDocument: () => void;
  onPickPhoto: () => void;
  onPickPasted?: () => void;
};

/** Attachment choices use the same bottom Hull action-sheet family as every menu. */
export function AttachmentPickerSheet({
  visible,
  onClose,
  onPickDocument,
  onPickPhoto,
  onPickPasted,
}: AttachmentPickerSheetProps) {
  const isDesktop = useIsDesktop();
  const pendingAction = React.useRef<(() => void) | null>(null);
  const dismiss = () => {
    const action = pendingAction.current;
    pendingAction.current = null;
    action?.();
  };
  const cancel = () => {
    pendingAction.current = null;
    onClose();
  };
  const choose = (action: () => void) => {
    if (pendingAction.current) return;
    // iOS cannot present a native picker until the Modal finishes dismissing.
    if (Platform.OS === 'ios') pendingAction.current = action;
    onClose();
    if (Platform.OS !== 'ios') action();
  };

  if (isDesktop) {
    return (
      <HullDialog
        accessibilityLabel="Close attachment picker"
        actions={[{ label: 'Cancel', onPress: cancel }]}
        onDismiss={dismiss}
        onRequestClose={cancel}
        scrimTestID="attachment-picker-scrim"
        testID="attachment-picker-sheet"
        title="Attach"
        visible={visible}
      >
        <HullActionSheetRow
          label="Photos"
          metadata="Choose up to 10"
          onPress={() => choose(onPickPhoto)}
          testID="attachment-picker-photo"
        />
        <HullActionSheetRow
          label="Files"
          metadata="Preserve original"
          onPress={() => choose(onPickDocument)}
          testID="attachment-picker-document"
        />
        {onPickPasted && (
          <HullActionSheetRow
            label="Paste from clipboard"
            onPress={() => choose(onPickPasted)}
            testID="attachment-picker-paste"
          />
        )}
      </HullDialog>
    );
  }

  return (
    <HullActionSheetModal
      accessibilityLabel="Close attachment picker"
      onClose={cancel}
      onDismiss={dismiss}
      scrimTestID="attachment-picker-scrim"
      testID="attachment-picker-sheet"
      title="Attach"
      visible={visible}
    >
      <HullActionSheetRow
        label="Photos"
        metadata="Choose up to 10"
        onPress={() => choose(onPickPhoto)}
        testID="attachment-picker-photo"
      />
      <HullActionSheetRow
        label="Files"
        metadata="Preserve original"
        onPress={() => choose(onPickDocument)}
        testID="attachment-picker-document"
      />
      {onPickPasted && (
        <HullActionSheetRow
          label="Paste from clipboard"
          onPress={() => choose(onPickPasted)}
          testID="attachment-picker-paste"
        />
      )}
      <HullActionSheetCancel onPress={cancel} testID="attachment-picker-close" />
    </HullActionSheetModal>
  );
}
