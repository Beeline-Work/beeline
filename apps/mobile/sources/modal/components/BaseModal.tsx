import React from 'react';
import { HullModal } from '@/components/buzz/HullDialog';

interface BaseModalProps {
  visible: boolean;
  onClose?: () => void;
  children: React.ReactNode;
  animationType?: 'fade' | 'slide' | 'none';
  closeOnBackdrop?: boolean;
  /** HullModal placement; 'center' (the default) caps content at 460pt wide
   *  and constrains no height, so a flex:1 child collapses — full-screen
   *  surfaces must ask for 'fill'. */
  placement?: 'bottom' | 'center' | 'fill';
}

export function BaseModal({
  visible,
  onClose,
  children,
  animationType = 'fade',
  closeOnBackdrop = true,
  placement = 'center',
}: BaseModalProps) {
  return (
    <HullModal
      visible={visible}
      animationType={animationType}
      dismissOnBackdrop={closeOnBackdrop}
      placement={placement}
      onRequestClose={onClose ?? (() => undefined)}
    >
      {children}
    </HullModal>
  );
}
