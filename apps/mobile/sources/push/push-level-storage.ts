import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_PUSH_LEVEL, isPushLevel, type PushLevel } from '@beeline/api-contract/phone';

const PUSH_LEVEL_PREFIX = '@beeline/push-level/';

export async function loadStoredPushLevel(pubkey: string): Promise<PushLevel> {
  const stored = await AsyncStorage.getItem(`${PUSH_LEVEL_PREFIX}${pubkey}`);
  return isPushLevel(stored) ? stored : DEFAULT_PUSH_LEVEL;
}

export async function saveStoredPushLevel(pubkey: string, level: PushLevel): Promise<void> {
  await AsyncStorage.setItem(`${PUSH_LEVEL_PREFIX}${pubkey}`, level);
}
