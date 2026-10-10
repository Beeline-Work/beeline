/**
 * The one check for which storage this runtime uses. A browser tab and the
 * Tauri desktop shell both run the web build, so both answer here and keep
 * their data in the origin's localStorage; `storage` is undefined only where
 * the browser denies it. Native answers null and uses MMKV and SecureStore.
 */
export function webRuntimeStorage(): { readonly storage: Storage | undefined } | null {
  if (typeof window === 'undefined' || typeof window.document === 'undefined') return null;
  try {
    return { storage: typeof localStorage === 'undefined' ? undefined : localStorage };
  } catch {
    return { storage: undefined };
  }
}
