import { MMKV } from 'react-native-mmkv';
import {
    type Settings,
    settingsDefaults,
    settingsParse,
    settingsToSyncPayload,
} from './settings';
import {
    type LocalSettings,
    localSettingsDefaults,
    localSettingsParse,
    type ThemePreference,
} from './localSettings';

const mmkv = new MMKV();

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

export function loadThemePreference(): ThemePreference {
    return loadLocalSettings().themePreference;
}

export function retrieveTempText(id: string): string | null {
    const key = `temp_text_${id}`;
    const content = mmkv.getString(key) ?? null;
    if (content) mmkv.delete(key);
    return content;
}
