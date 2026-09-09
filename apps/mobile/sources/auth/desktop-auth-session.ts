import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { isDesktopShell } from '@/utils/isDesktopShell';

interface AuthSessionResult {
  type: string;
  url?: string;
}

interface AuthUrlSubscription {
  remove(): void;
}

export async function initialAuthUrl(): Promise<string | null> {
  if (!isDesktopShell()) return Linking.getInitialURL();
  const { getCurrent } = await import('@tauri-apps/plugin-deep-link');
  return (await getCurrent())?.find((url) => url.startsWith('beeline://')) ?? null;
}

export async function openAccountAuthSession(
  authorizationUrl: string,
  redirectUri: string,
  options: Record<string, unknown>,
): Promise<AuthSessionResult> {
  if (!isDesktopShell()) {
    return WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri, options);
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(authorizationUrl);
  return { type: 'opened' };
}

export function subscribeToAuthUrls(
  listener: (url: string) => void,
): AuthUrlSubscription | Promise<AuthUrlSubscription> {
  if (!isDesktopShell()) {
    return Linking.addEventListener('url', ({ url }) => listener(url));
  }
  return import('@tauri-apps/plugin-deep-link').then(async ({ onOpenUrl }) => {
    const unlisten = await onOpenUrl((urls) => urls.forEach(listener));
    return { remove: unlisten };
  });
}
