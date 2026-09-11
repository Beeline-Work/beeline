import React from 'react';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';
import { HullDialog } from './HullDialog';
import { useIsDesktop } from '@/utils/responsive';

type AttachmentPickerSheetProps = {
  visible: boolean;
  onClose: () => void;
  onPickDocument: () => void;
  onPickPhoto: () => void;
};

/** Attachment choices use the same bottom Hull action-sheet family as every menu. */
export function AttachmentPickerSheet({
  visible,
  onClose,
  onPickDocument,
  onPickPhoto,
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
          label="Document"
          metadata="This device"
          onPress={() => choose(onPickDocument)}
          testID="attachment-picker-document"
        />
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
        label="Document"
        metadata="This device"
        onPress={() => choose(onPickDocument)}
        testID="attachment-picker-document"
      />
      <HullActionSheetCancel onPress={onClose} testID="attachment-picker-close" />
    </HullActionSheetModal>
  );
}
