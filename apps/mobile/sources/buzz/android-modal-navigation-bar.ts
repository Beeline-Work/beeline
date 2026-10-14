type ModalNavigationBarNative = {
  clearModalNavigationBarScrim?: () => void;
};

function nativeModule(): ModalNavigationBarNative | null {
  try {
    // Lazy — tests, iOS and web never have the Android half.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('expo-modules-core');
    if (typeof core?.requireOptionalNativeModule !== 'function') return null;
    return core.requireOptionalNativeModule('AndroidModalNavigationBar');
  } catch {
    return null;
  }
}

/** Removes Android's white 3-button navigation scrim from open Modal windows. */
export function clearModalNavigationBarScrim(): void {
  nativeModule()?.clearModalNavigationBarScrim?.();
}
