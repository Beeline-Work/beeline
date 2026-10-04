import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { isDesktopShell } from '@/utils/isDesktopShell';
import { openExternalUrl } from '@/utils/open-external-url';

const RETURN_KEY = 'beeline.app-sign-in-return.v1';

export type AppSignInReturn = { workspaceId: string; appId: string; viewerId?: string; roomId?: string };

/** The URL is server-issued and kept out of Room history. The server verifies the callback. */
export async function openAppSignIn(url: string, destination: AppSignInReturn): Promise<void> {
  await AsyncStorage.setItem(RETURN_KEY, JSON.stringify(destination));
  if (Platform.OS === 'web' && !isDesktopShell() && typeof window !== 'undefined') {
    // A browser cannot open beeline://, so web starts through the server, which
    // sends the provider's return back to this origin. The same tab keeps the
    // tab-scoped web session for completing the sign-in.
    const start = new URL(`${getBuzzRuntimeConfig().monolithUrl}/v1/apps/oauth/start`);
    start.searchParams.set('authorization', url);
    start.searchParams.set('return', window.location.origin);
    window.location.assign(start.toString());
    return;
  }
  await openExternalUrl(url);
}

export async function takeAppSignInReturn(): Promise<AppSignInReturn | null> {
  const stored = await AsyncStorage.getItem(RETURN_KEY);
  if (!stored) return null;
  await AsyncStorage.removeItem(RETURN_KEY);
  try { return JSON.parse(stored) as AppSignInReturn; } catch { return null; }
}
