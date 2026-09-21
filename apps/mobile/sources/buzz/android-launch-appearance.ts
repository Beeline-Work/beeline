import { loadAppearanceChoice, saveAppearanceChoice } from '@/sync/persistence';
import type { LocalSettings } from '@/sync/localSettings';
import { setAndroidNightMode } from './android-launch-appearance-native';

/** The Android launch theme follows the same authority the app renders from.
 *  A never-chosen appearance is not pinned: the splash follows the system
 *  exactly like the seeded app does. An explicit choice is pinned so the
 *  splash matches it on every later cold start. */
export function applyEffectiveAndroidLaunchAppearance(): void {
  const choice = loadAppearanceChoice();
  if (choice === null) return;
  setAndroidNightMode(choice);
}

/** Settings → Appearance write path. Records the choice — the marker that
 *  protects it from later system seeding — before the native call, so a kill
 *  mid-call still reapplies on the next cold start. */
export function pinAndroidLaunchAppearance(appearance: LocalSettings['appearance']): void {
  saveAppearanceChoice(appearance);
  setAndroidNightMode(appearance);
}
