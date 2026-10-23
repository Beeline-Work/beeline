import { MMKV } from 'react-native-mmkv';
import { webRuntimeStorage } from '@/utils/web-storage';
import { webStringStorage, type BrowserStringStorage } from './browser-string-storage';
import { type Settings, settingsDefaults, settingsParse, settingsToSyncPayload } from './settings';
import { type LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';

/** The web build (browser and Tauri) has no MMKV host object. Keep the same
 * synchronous settings contract through browser storage; native keeps MMKV. */
const web = webRuntimeStorage();
const SETTINGS_NAMESPACE = 'beeline.settings.';
const mmkv: BrowserStringStorage = web
  ? webStringStorage(web.storage, SETTINGS_NAMESPACE)
  : new MMKV();

export type SettingsKey = 'settings' | 'local-settings';

/** Another tab wrote these settings. Only the web build shares storage between tabs. */
export function subscribeSettingsWrites(listener: (key: SettingsKey) => void): () => void {
  const shared = web?.storage;
  if (!shared || typeof window.addEventListener !== 'function') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== shared) return;
    for (const key of ['settings', 'local-settings'] as const)
      if (event.key === null || event.key === `${SETTINGS_NAMESPACE}${key}`) listener(key);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

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

/** Launch preference mirrored for Android's native splash. Keep the legacy
 * key so existing installations can migrate without losing their settings. */
const APPEARANCE_CHOICE_KEY = 'appearance-launch';

export function loadAppearanceChoice(): 'system' | 'light' | 'dark' | null {
  const raw = mmkv.getString(APPEARANCE_CHOICE_KEY);
  return raw === 'system' || raw === 'light' || raw === 'dark' ? raw : null;
}

export function saveAppearanceChoice(mode: 'system' | 'light' | 'dark'): void {
  mmkv.set(APPEARANCE_CHOICE_KEY, mode);
}

export function storeTempText(content: string): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  mmkv.set(`temp_text_${id}`, content);
  return id;
}

export function retrieveTempText(id: string): string | null {
  const key = `temp_text_${id}`;
  const content = mmkv.getString(key) ?? null;
  if (content) mmkv.delete(key);
  return content;
}

/** Move existing installations to System once, preserving later choices. */
export function migrateSystemAppearance(): void {
  if (mmkv.getString('appearance-system-v1') === 'done') return;
  saveLocalSettings({ ...loadLocalSettings(), appearance: 'system' });
  saveAppearanceChoice('system');
  mmkv.set('appearance-system-v1', 'done');
}
