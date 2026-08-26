import React from 'react';
import { HullModal } from '@/components/buzz/HullDialog';

interface BaseModalProps {
  visible: boolean;
  onClose?: () => void;
  children: React.ReactNode;
  animationType?: 'fade' | 'slide' | 'none';
  closeOnBackdrop?: boolean;
}

export function BaseModal({
  visible,
  onClose,
  children,
  animationType = 'fade',
  closeOnBackdrop = true,
}: BaseModalProps) {
  return (
    <HullModal
      visible={visible}
      animationType={animationType}
      dismissOnBackdrop={closeOnBackdrop}
      onRequestClose={onClose ?? (() => undefined)}
    >
      {children}
    </HullModal>
  );
}
