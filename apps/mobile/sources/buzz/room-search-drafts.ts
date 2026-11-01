import AsyncStorage from '@react-native-async-storage/async-storage';

/** Search is screen state; discard drafts saved by older app versions. */
export async function removeRoomSearchDrafts(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const obsolete = keys.filter((key) =>
      /^beeline\.text-draft\.v1:[^:]+:(?:room-search|sidebar-room-search)%3A/i.test(key),
    );
    if (obsolete.length) await AsyncStorage.multiRemove(obsolete);
  } catch {
    // Storage cleanup must not interrupt navigation. A later mount retries it.
  }
}
