import React from 'react';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

type ForwardCornerSheetProps = {
  onClose: () => void;
  onOpen: () => void;
  visible: boolean;
};

/**
 * Mobile swipe-right on a message asks whether to forward it into a new
 * corner. It is the same "Begin a new corner" sheet the corners list + opens,
 * with one line saying the chosen message becomes the starting topic.
 */
export function ForwardCornerSheet({ onClose, onOpen, visible }: ForwardCornerSheetProps) {
  return (
    <HullActionSheetModal
      accessibilityLabel={`Close new ${CORNER_LABEL} prompt`}
      onClose={onClose}
      subtitle={`Start a new ${CORNER_LABEL} with the chosen message as the starting topic.`}
      testID="forward-corner-sheet"
      title={`Begin a new ${CORNER_LABEL}`}
      visible={visible}
    >
      <HullActionSheetRow
        label={`Open ${CORNER_LABEL}`}
        onPress={onOpen}
        testID="forward-corner-open"
      />
      <HullActionSheetCancel onPress={onClose} testID="forward-corner-cancel" />
    </HullActionSheetModal>
  );
}
