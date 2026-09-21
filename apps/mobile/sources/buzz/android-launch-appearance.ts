import {
  loadAppearanceLaunch,
  saveAppearanceLaunch,
  type AppearanceLaunch,
} from '@/sync/persistence';
import type { LocalSettings } from '@/sync/localSettings';
import { setAndroidNightMode } from './android-launch-appearance-native';

export type { AppearanceLaunch };

/** Settings → Appearance write path for the next Android splash.
 *  Persist first so a kill mid-call still reapplies on the following JS start.
 *  The OS call itself is one package-scoped write — no launcher-component
 *  swap, so the icon cannot duplicate or vanish. */
export function pinAndroidLaunchAppearance(appearance: LocalSettings['appearance']): void {
  saveAppearanceLaunch(appearance);
  setAndroidNightMode(appearance);
}

/** Cold-start catch-up for a pin that already exists. Never treats the
 *  default in-app appearance ('dark') as a pin. */
export function applyPersistedAndroidLaunchAppearance(): void {
  const launch = loadAppearanceLaunch();
  if (launch === 'system') return;
  setAndroidNightMode(launch);
}

export function currentAppearanceLaunch(): AppearanceLaunch {
  return loadAppearanceLaunch();
}
