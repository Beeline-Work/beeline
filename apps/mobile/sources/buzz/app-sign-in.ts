import AsyncStorage from '@react-native-async-storage/async-storage';
import { openExternalUrl } from '@/utils/open-external-url';

const RETURN_KEY = 'beeline.app-sign-in-return.v1';

export type AppSignInReturn = { workspaceId: string; viewerId?: string; roomId?: string };

/** The URL is server-issued and kept out of Room history. The server verifies the callback. */
export async function openAppSignIn(url: string, destination: AppSignInReturn): Promise<void> {
  await AsyncStorage.setItem(RETURN_KEY, JSON.stringify(destination));
  await openExternalUrl(url);
}

export async function takeAppSignInReturn(): Promise<AppSignInReturn | null> {
  const stored = await AsyncStorage.getItem(RETURN_KEY);
  if (!stored) return null;
  await AsyncStorage.removeItem(RETURN_KEY);
  try { return JSON.parse(stored) as AppSignInReturn; } catch { return null; }
}
