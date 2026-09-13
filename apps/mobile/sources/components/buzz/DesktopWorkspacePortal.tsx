import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { createPortal } from 'react-dom';

/** Lift desktop chrome above Expo's Drawer without changing its layout. */
export function DesktopWorkspacePortal({ children }: { children: ReactNode }) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}
