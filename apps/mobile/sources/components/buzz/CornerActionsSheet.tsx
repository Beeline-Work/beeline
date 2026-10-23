import React, { useEffect, useRef, useState } from 'react';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';
import { CornerLockAction } from './CornerLockAction';

/** Closing the surface leaves the request running, but retires its navigation. */
export function CornerActionsSheet({
  visible,
  title,
  locked,
  connected,
  onClose,
  closeCorner,
  setLocked,
  onClosed,
  onSaved,
  onError,
}: {
  visible: boolean;
  title: string;
  locked: boolean;
  connected: boolean;
  onClose: () => void;
  closeCorner: () => Promise<void>;
  setLocked: (locked: boolean) => Promise<void>;
  onClosed: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  const [closing, setClosing] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const lockGeneration = useRef(-1);
  useEffect(() => {
    generation.current += 1;
    setClosing(false);
    pending.current = false;
    return () => {
      generation.current += 1;
    };
  }, [visible]);
  const dismiss = () => {
    generation.current += 1;
    onClose();
  };
  const close = async () => {
    if (pending.current) return;
    const attempt = generation.current;
    pending.current = true;
    setClosing(true);
    try {
      await closeCorner();
      if (attempt === generation.current) onClosed();
    } catch (error) {
      if (attempt === generation.current) onError(error);
    } finally {
      if (attempt === generation.current) {
        pending.current = false;
        setClosing(false);
      }
    }
  };
  return (
    <HullActionSheetModal
      accessibilityLabel="Close corner actions"
      onClose={dismiss}
      testID="corner-actions-sheet"
      title={title}
      visible={visible}
    >
      <CornerLockAction
        locked={locked}
        disabled={closing || !connected}
        save={async (value) => {
          lockGeneration.current = generation.current;
          await setLocked(value);
        }}
        onSaved={() => {
          if (lockGeneration.current === generation.current) onSaved();
        }}
        onError={(error) => {
          if (lockGeneration.current === generation.current) onError(error);
        }}
      />
      <HullActionSheetRow
        accessibilityLabel="Close corner"
        description="Ends the edit session and archives this corner. Unmerged work is lost."
        destructive
        disabled={closing}
        label={closing ? 'Closing corner…' : 'Close corner'}
        onPress={() => void close()}
        testID="close-corner-action"
      />
      <HullActionSheetCancel onPress={dismiss} testID="corner-actions-close" />
    </HullActionSheetModal>
  );
}
