import React from 'react';
import { HullDialog, type HullDialogAction } from '@/components/buzz/HullDialog';
import { AlertModalConfig, ConfirmModalConfig } from '../types';

interface WebAlertModalProps {
  config: AlertModalConfig | ConfirmModalConfig;
  onClose: () => void;
  onConfirm?: (value: boolean) => void;
}

/** Historical export name; the implementation is app-wide and Hull-native. */
export function WebAlertModal({ config, onClose, onConfirm }: WebAlertModalProps) {
  const isConfirm = config.type === 'confirm';
  const buttons = isConfirm
    ? [
        { text: config.cancelText || 'Cancel', style: 'cancel' as const },
        {
          text: config.confirmText || 'OK',
          style: config.destructive ? ('destructive' as const) : ('default' as const),
        },
      ]
    : config.buttons || [{ text: 'OK', style: 'default' as const }];
  const hasCancel = buttons.some((button) => button.style === 'cancel');
  const primaryIndex = hasCancel
    ? buttons
        .map((button, index) => ({ button, index }))
        .filter(({ button }) => !button.style || button.style === 'default')
        .at(-1)?.index
    : undefined;
  const actions: HullDialogAction[] = buttons.map((button, index) => ({
    label: button.text,
    variant:
      button.style === 'destructive' ? 'destructive' : index === primaryIndex ? 'primary' : 'quiet',
    onPress: () => {
      if (isConfirm) {
        onConfirm?.(index === 1);
        return;
      }
      button.onPress?.();
      onClose();
    },
  }));

  const dismiss = () => {
    if (isConfirm) onConfirm?.(false);
    else onClose();
  };

  return (
    <HullDialog
      actions={actions}
      body={config.message}
      dismissOnBackdrop={!isConfirm}
      onRequestClose={dismiss}
      testID="hull-alert-dialog"
      title={config.title}
      visible
    />
  );
}
