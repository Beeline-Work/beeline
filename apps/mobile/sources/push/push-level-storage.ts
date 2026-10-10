import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_PUSH_LEVEL, isPushLevel, type PushLevel } from '@beeline/api-contract/phone';

const PUSH_LEVEL_PREFIX = '@beeline/push-level/';
const pushLevelListeners = new Set<(pubkey: string, level: PushLevel) => void>();

/** Device copy of the server's push level: a cold-start hint until the server answers. */
export async function loadStoredPushLevel(pubkey: string): Promise<PushLevel> {
  const stored = await AsyncStorage.getItem(`${PUSH_LEVEL_PREFIX}${pubkey}`);
  return isPushLevel(stored) ? stored : DEFAULT_PUSH_LEVEL;
}

/** The one writer: store a server-proven level and tell every mounted reader. */
export async function saveStoredPushLevel(pubkey: string, level: PushLevel): Promise<void> {
  await AsyncStorage.setItem(`${PUSH_LEVEL_PREFIX}${pubkey}`, level);
  pushLevelListeners.forEach((listener) => listener(pubkey, level));
}

export function subscribeStoredPushLevel(
  listener: (pubkey: string, level: PushLevel) => void,
): () => void {
  pushLevelListeners.add(listener);
  return () => {
    pushLevelListeners.delete(listener);
  };
}

/** A mounted reader's level: the device copy first, then every later save for `pubkey`. */
export function watchStoredPushLevel(
  pubkey: string,
  listener: (level: PushLevel) => void,
): () => void {
  let heard = false;
  let stopped = false;
  const stop = subscribeStoredPushLevel((changed, level) => {
    if (changed !== pubkey) return;
    heard = true;
    listener(level);
  });
  void loadStoredPushLevel(pubkey)
    .catch(() => DEFAULT_PUSH_LEVEL)
    .then((level) => {
      if (!heard && !stopped) listener(level);
    });
  return () => {
    stopped = true;
    stop();
  };
}
