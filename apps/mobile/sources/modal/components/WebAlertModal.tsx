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
  const pendingRef = React.useRef(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    if (pendingRef.current || config.type !== 'confirm') return;
    if (!config.onConfirm) { onConfirm?.(true); return; }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await config.onConfirm();
      onConfirm?.(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not complete this action. Try again.');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
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
    label: pending && isConfirm && index === 1 ? (config.pendingText ?? 'Working…') : button.text,
    loading: pending && isConfirm && index === 1,
    disabled: pending || Boolean(button.disabled),
    testID: isConfirm
      ? index === 0
        ? 'hull-confirm-cancel'
        : 'hull-confirm-submit'
      : `hull-alert-action-${index}`,
    variant:
      button.style === 'destructive' ? 'destructive' : index === primaryIndex ? 'primary' : 'quiet',
    onPress: () => {
      if (isConfirm) {
        if (pendingRef.current) return;
        if (index === 1) void submit();
        else onConfirm?.(false);
        return;
      }
      button.onPress?.();
      onClose();
    },
  }));

  const dismiss = () => {
    if (pendingRef.current) return;
    if (isConfirm) onConfirm?.(false);
    else onClose();
  };

  return (
    <HullDialog
      actions={actions}
      body={[config.message, error].filter(Boolean).join('\n\n')}
      dismissOnBackdrop={isConfirm && !pending}
      onRequestClose={dismiss}
      scrimTestID={isConfirm ? 'hull-confirm-dismiss' : undefined}
      testID="hull-alert-dialog"
      title={config.title}
      visible
    />
  );
}
