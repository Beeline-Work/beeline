import React from 'react';
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
  const choose = (action: () => void) => {
    onClose();
    action();
  };

  if (isDesktop) {
    return (
      <HullDialog
        accessibilityLabel="Close attachment picker"
        actions={[{ label: 'Cancel', onPress: onClose }]}
        onRequestClose={onClose}
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
          label="Send as file"
          metadata="Preserve original"
          onPress={() => choose(onPickDocument)}
          testID="attachment-picker-document"
        />
        {onPickPasted && (
          <HullActionSheetRow
            label="Paste Image"
            metadata="From clipboard"
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
      onClose={onClose}
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
        label="Send as file"
        metadata="Preserve original"
        onPress={() => choose(onPickDocument)}
        testID="attachment-picker-document"
      />
      {onPickPasted && (
        <HullActionSheetRow
          label="Paste Image"
          metadata="From clipboard"
          onPress={() => choose(onPickPasted)}
          testID="attachment-picker-paste"
        />
      )}
      <HullActionSheetCancel onPress={onClose} testID="attachment-picker-close" />
    </HullActionSheetModal>
  );
}
