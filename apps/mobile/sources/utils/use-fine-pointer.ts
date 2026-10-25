import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

const query = '(min-width: 768px) and (hover: hover) and (pointer: fine)';
const media = () =>
  Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;
function subscribe(listener: () => void) {
  const match = media();
  match?.addEventListener('change', listener);
  return () => match?.removeEventListener('change', listener);
}
export function useFinePointer() {
  return useSyncExternalStore(
    subscribe,
    () => media()?.matches ?? false,
    () => false,
  );
}
