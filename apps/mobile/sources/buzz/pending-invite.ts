import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseCommunityInviteToken } from '@/buzz/community-invite';

/**
 * An invite link opened before the person is signed in. It is kept on the
 * device across the whole sign-in ceremony (the GitHub round trip relaunches
 * the app) so that, once an identity exists, the invite wins over the generic
 * create-or-join choice. It is spent by the invite screen the moment that
 * screen resolves it — join, "not my invite", or an invalid link — so it can
 * never send the person back there twice.
 */
const KEY = '@beeline/pending-invite/v1';
/** An invite is only valid for days; a token parked longer is not a plan. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function savePendingInvite(token: string, now = Date.now()): Promise<void> {
  const parsed = parseCommunityInviteToken(token);
  if (!parsed) return;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ token: parsed, savedAt: now }));
  } catch {
    // Without storage the link still works when opened again.
  }
}

export async function loadPendingInvite(now = Date.now()): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { token?: unknown; savedAt?: unknown };
    const token = typeof value.token === 'string' ? parseCommunityInviteToken(value.token) : null;
    if (!token || typeof value.savedAt !== 'number' || now - value.savedAt > MAX_AGE_MS) {
      await AsyncStorage.removeItem(KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export async function clearPendingInvite(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // Nothing further to do.
  }
}
