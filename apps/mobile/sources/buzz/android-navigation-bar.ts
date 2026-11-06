import { requireNativeModule } from 'expo-modules-core';

/** Keep ownership of the native promise: Expo's setStyle discards it. */
export async function setAndroidNavigationBarStyle(style: 'light' | 'dark'): Promise<void> {
  try {
    await requireNativeModule<{
      setButtonStyleAsync(style: 'light' | 'dark'): Promise<void>;
    }>('ExpoNavigationBar').setButtonStyleAsync(style === 'dark' ? 'light' : 'dark');
  } catch (error) {
    console.warn('Could not style the Android navigation bar', error);
  }
}
