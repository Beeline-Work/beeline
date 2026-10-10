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
