type NightModeNative = {
  setNightMode?: (mode: 'light' | 'dark') => void;
};

function nativeModule(): NightModeNative | null {
  try {
    // Lazy — tests and web never have the Android half. Ask expo-modules-core
    // first so a missing native module cannot throw (same as speech).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('expo-modules-core');
    if (typeof core?.requireOptionalNativeModule !== 'function') return null;
    return core.requireOptionalNativeModule('AndroidLaunchAppearance');
  } catch {
    return null;
  }
}

export function setAndroidNightMode(mode: 'light' | 'dark'): void {
  nativeModule()?.setNightMode?.(mode);
}
