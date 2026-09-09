import { isDesktopShell } from '@/utils/isDesktopShell';

export function desktopAuthRedirectUri(
  path: string,
  fallback: string,
  desktop = isDesktopShell(),
): string {
  return desktop ? `beeline://beeline/${path}` : fallback;
}
