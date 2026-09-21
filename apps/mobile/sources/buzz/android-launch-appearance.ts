import { loadLocalSettings } from '@/sync/persistence';
import type { LocalSettings } from '@/sync/localSettings';
import { setAndroidNightMode } from './android-launch-appearance-native';

/** The one Android launch-theme authority: the app's EFFECTIVE appearance.
 *
 *  `LocalSettings['appearance']` is `'light' | 'dark'` and never `'system'`,
 *  so the app never genuinely follows the system and this is always a pin.
 *  Reading only an explicitly-toggled launch key left a person who never
 *  opened Settings → Appearance on a system-following splash (cream on a
 *  light system) over the dark app it actually renders. The splash and the
 *  app must agree, so the default is a pin too. */
export function applyEffectiveAndroidLaunchAppearance(): void {
  const { appearance } = loadLocalSettings();
  setAndroidNightMode(appearance);
}

/** Settings → Appearance write path. The caller has already committed the
 *  choice to local settings (`useLocalSettingMutable`), so a kill before
 *  this native call still reapplies on the next cold start through
 *  `applyEffectiveAndroidLaunchAppearance`. */
export function pinAndroidLaunchAppearance(appearance: LocalSettings['appearance']): void {
  setAndroidNightMode(appearance);
}
