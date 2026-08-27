import React from 'react';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

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
  const choose = (action: () => void) => {
    onClose();
    action();
  };

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
        label="Photo"
        metadata="Photo library"
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
