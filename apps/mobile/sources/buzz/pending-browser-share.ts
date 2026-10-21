import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@beeline/pending-browser-share/v1';
export function validBrowserShareId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id);
}

/** Preserve only the share id across sign-in, never a viewer capability. */
export async function savePendingBrowserShare(id: string): Promise<void> {
  if (validBrowserShareId(id)) await AsyncStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() }));
}

export async function takePendingBrowserShare(): Promise<string | null> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return null;
  await AsyncStorage.removeItem(KEY);
  try {
    const value = JSON.parse(raw);
    return validBrowserShareId(value.id) && typeof value.at === 'number'
      && Date.now() - value.at < 60 * 60_000 ? value.id : null;
  } catch { return null; }
}
