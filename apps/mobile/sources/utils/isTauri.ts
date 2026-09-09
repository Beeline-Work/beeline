import { Platform } from 'react-native';
import { isDesktopShell } from './isDesktopShell';

export function isTauri(): boolean {
  return Platform.OS === 'web' && isDesktopShell();
}
