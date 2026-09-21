import { Appearance } from 'react-native';
import type { LocalSettings } from '@/sync/localSettings';
import {
  loadAppearanceChoice,
  loadLocalSettings,
  saveLocalSettings,
} from '@/sync/persistence';

type AppAppearance = LocalSettings['appearance'];

/** A never-chosen appearance follows the system dark-mode setting — an
 *  accessibility preference, never a hardcoded dark default. It is re-seeded
 *  on every cold start, so a system change reaches the app too. An explicit
 *  Settings → Appearance choice is recorded separately (`appearance-launch`)
 *  and is never seeded over. */
export function seedAppAppearanceFromSystem(): AppAppearance {
  const stored = loadLocalSettings();
  if (loadAppearanceChoice() !== null) return stored.appearance;
  const appearance: AppAppearance = Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
  saveLocalSettings({ ...stored, appearance });
  return appearance;
}
