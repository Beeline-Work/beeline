import { Linking } from 'react-native';
import { isDesktopShell } from '@/utils/isDesktopShell';

/** Open an external destination through the host boundary each platform supports. */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isDesktopShell()) {
    await Linking.openURL(url);
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}
