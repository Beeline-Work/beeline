import React from 'react';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import { HullDialog } from './HullDialog';

type ForwardCornerSheetProps = {
  onClose: () => void;
  onOpen: () => void;
  visible: boolean;
};

/**
 * Mobile swipe-right on a message asks whether to forward it into a new
 * corner. The prompt says the chosen message becomes the starting topic.
 */
export function ForwardCornerSheet({ onClose, onOpen, visible }: ForwardCornerSheetProps) {
  return (
    <HullDialog
      accessibilityLabel={`Close new ${CORNER_LABEL} prompt`}
      onRequestClose={onClose}
      body={`Start a new ${CORNER_LABEL} with the chosen message as the starting topic.`}
      testID="forward-corner-sheet"
      title={`Begin a new ${CORNER_LABEL}`}
      visible={visible}
      actions={[
        { label: 'Cancel', onPress: onClose, testID: 'forward-corner-cancel' },
        {
          label: `Open ${CORNER_LABEL}`,
          onPress: onOpen,
          variant: 'primary',
          testID: 'forward-corner-open',
        },
      ]}
    />
  );
}
