import { MMKV } from 'react-native-mmkv';
import { Platform } from 'react-native';
import { webStringStorage, type BrowserStringStorage } from './browser-string-storage';
import { type Settings, settingsDefaults, settingsParse, settingsToSyncPayload } from './settings';
import { type LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';

/** Ordinary Expo web has no MMKV host object. Keep the same synchronous
 * settings contract through browser storage; native and Tauri retain MMKV. */
const browserStorage =
  Platform.OS === 'web' && typeof localStorage !== 'undefined' ? localStorage : undefined;
const mmkv: BrowserStringStorage =
  Platform.OS === 'web' ? webStringStorage(browserStorage, 'beeline.settings.') : new MMKV();

export function loadSettings(): { settings: Settings; version: number | null } {
  const raw = mmkv.getString('settings');
  if (!raw) return { settings: { ...settingsDefaults }, version: null };
  try {
    const parsed = JSON.parse(raw);
    return { settings: settingsParse(parsed.settings), version: parsed.version ?? null };
  } catch (error) {
    console.error('Failed to parse settings', error);
    return { settings: { ...settingsDefaults }, version: null };
  }
}

export function saveSettings(settings: Settings, version: number): void {
  mmkv.set('settings', JSON.stringify({ settings: settingsToSyncPayload(settings), version }));
}

export function loadLocalSettings(): LocalSettings {
  const raw = mmkv.getString('local-settings');
  if (!raw) return { ...localSettingsDefaults };
  try {
    return localSettingsParse(JSON.parse(raw));
  } catch (error) {
    console.error('Failed to parse local settings', error);
    return { ...localSettingsDefaults };
  }
}

export function saveLocalSettings(settings: LocalSettings): void {
  mmkv.set('local-settings', JSON.stringify(settings));
}

export function retrieveTempText(id: string): string | null {
  const key = `temp_text_${id}`;
  const content = mmkv.getString(key) ?? null;
  if (content) mmkv.delete(key);
  return content;
}
