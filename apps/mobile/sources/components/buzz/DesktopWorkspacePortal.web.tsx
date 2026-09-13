import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Lift desktop chrome above Expo's Drawer without changing its layout. */
export function DesktopWorkspacePortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}
