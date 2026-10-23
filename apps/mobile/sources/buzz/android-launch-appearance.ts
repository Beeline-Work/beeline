import { loadAppearanceChoice, saveAppearanceChoice } from '@/sync/persistence';
import type { LocalSettings } from '@/sync/localSettings';
import { setAndroidNightMode } from './android-launch-appearance-native';

/** Restore the selected launch theme, clearing old native pins for System. */
export function applyEffectiveAndroidLaunchAppearance(): void {
  const choice = loadAppearanceChoice();
  setAndroidNightMode(choice ?? 'system');
}

/** Settings → Appearance write path. Records the choice — the marker that
 *  protects it from later system seeding — before the native call, so a kill
 *  mid-call still reapplies on the next cold start. */
export function pinAndroidLaunchAppearance(appearance: LocalSettings['appearance']): void {
  saveAppearanceChoice(appearance);
  setAndroidNightMode(appearance);
}
