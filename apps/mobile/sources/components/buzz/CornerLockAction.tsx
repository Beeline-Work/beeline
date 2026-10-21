import * as React from 'react';
import { HullActionSheetRow } from './HullActionSheet';

/** The value comes from the current server Room read. */
export function CornerLockAction({ locked, disabled, save, onSaved, onError }: {
  locked: boolean;
  disabled?: boolean;
  save(locked: boolean): Promise<void>;
  onSaved(): void;
  onError(error: unknown): void;
}) {
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const change = async (value: boolean) => {
    if (savingRef.current || disabled) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await save(value);
      onSaved();
    } catch (error) {
      onError(error);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return <HullActionSheetRow
    label="Lock corner"
    description="Stops agents from closing this corner, including after a merge. You can still close it."
    disabled={disabled || saving}
    onPress={() => change(!locked)}
    testID="lock-corner-action"
    toggle={{ value: locked, onValueChange: change }}
  />;
}
