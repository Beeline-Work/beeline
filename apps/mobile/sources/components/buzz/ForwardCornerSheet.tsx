import React from 'react';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import {
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from './HullActionSheet';

type ForwardCornerSheetProps = {
  onClose: () => void;
  onOpen: () => void;
  visible: boolean;
};

/**
 * Mobile swipe-right on a message asks whether to forward it into a new
 * corner. That ask is the shared bottom sheet, not a centred confirm dialog:
 * the whole corner flow presents the same way Room creation does (C102's one
 * presentation authority for floating surfaces).
 */
export function ForwardCornerSheet({ onClose, onOpen, visible }: ForwardCornerSheetProps) {
  return (
    <HullActionSheetModal
      accessibilityLabel={`Close new ${CORNER_LABEL} prompt`}
      onClose={onClose}
      subtitle={`A human-owned ${CORNER_LABEL} opens with this message ready to send in its composer.`}
      testID="forward-corner-sheet"
      title={`Forward to a new ${CORNER_LABEL}?`}
      visible={visible}
    >
      <HullActionSheetRow
        accessibilityLabel={`Open a new ${CORNER_LABEL}`}
        label={`Open a new ${CORNER_LABEL}`}
        onPress={onOpen}
        testID="forward-corner-open"
      />
      <HullActionSheetCancel onPress={onClose} testID="forward-corner-cancel" />
    </HullActionSheetModal>
  );
}