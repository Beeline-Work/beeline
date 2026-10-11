import * as React from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { applyLocalSettings, type LocalSettings } from './localSettings';
import { applySettings, type Settings } from './settings';
import {
    loadLocalSettings,
    loadSettings,
    saveLocalSettings,
    saveSettings,
    subscribeSettingsWrites,
} from './persistence';

interface StorageState {
    settings: Settings;
    localSettings: LocalSettings;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
}

const initialSettings = loadSettings();

export const storage = create<StorageState>()((set) => ({
    settings: initialSettings.settings,
    localSettings: loadLocalSettings(),
    applySettingsLocal: (delta) => set((state) => {
        const settings = applySettings(state.settings, delta);
        saveSettings(settings, initialSettings.version ?? 0);
        return { settings };
    }),
    applyLocalSettings: (delta) => set((state) => {
        const localSettings = applyLocalSettings(state.localSettings, delta);
        saveLocalSettings(localSettings);
        return { localSettings };
    }),
}));

// Another tab's settings change reaches this tab without a reload.
subscribeSettingsWrites((key) => {
    if (key === 'settings') storage.setState({ settings: loadSettings().settings });
    else storage.setState({ localSettings: loadLocalSettings() });
});

export function useSettings(): Settings {
    return storage(useShallow((state) => state.settings));
}

export function useLocalSettings(): LocalSettings {
    return storage(useShallow((state) => state.localSettings));
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(
    name: K,
): [LocalSettings[K], (value: LocalSettings[K]) => void] {
    const value = useLocalSetting(name);
    const setValue = React.useCallback((next: LocalSettings[K]) => {
        storage.getState().applyLocalSettings({ [name]: next });
    }, [name]);
    return [value, setValue];
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
    return storage(useShallow((state) => state.localSettings[name]));
}
