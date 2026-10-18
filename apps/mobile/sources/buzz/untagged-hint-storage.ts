import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = '@beeline/untagged-hint-shown/';
const pending = new Map<string, Promise<unknown>>();

export async function loadUntaggedHintCount(pubkey: string): Promise<number> {
  const value = await AsyncStorage.getItem(`${PREFIX}${pubkey}`);
  if (value === null) return 0;
  return value === '0' ? 0 : value === '1' ? 1 : 2;
}

/** Serialize mounted Rooms and persist the allowance before displaying it. */
function updateUntaggedHint(pubkey: string, retire: boolean): Promise<boolean> {
  const previous = pending.get(pubkey) ?? Promise.resolve();
  const next = previous.then(async () => {
    if (retire) {
      await AsyncStorage.setItem(`${PREFIX}${pubkey}`, '2');
      return false;
    }
    const count = await loadUntaggedHintCount(pubkey);
    if (count >= 2) return false;
    await AsyncStorage.setItem(`${PREFIX}${pubkey}`, String(count + 1));
    return true;
  }).catch(() => false);
  pending.set(pubkey, next);
  void next.then(() => { if (pending.get(pubkey) === next) pending.delete(pubkey); });
  return next;
}

export function reserveUntaggedHint(pubkey: string): Promise<boolean> {
  return updateUntaggedHint(pubkey, false);
}

/** A successful tagged send retires teaching on this account and device. */
export async function retireUntaggedHints(pubkey: string): Promise<void> {
  await updateUntaggedHint(pubkey, true);
}
