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

export function useSettings(): Settings {
    return storage(useShallow((state) => state.settings));
}

export function useSettingMutable<K extends keyof Settings>(
    name: K,
): [Settings[K], (value: Settings[K]) => void] {
    const value = useSetting(name);
    const setValue = React.useCallback((next: Settings[K]) => {
        storage.getState().applySettingsLocal({ [name]: next });
    }, [name]);
    return [value, setValue];
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
    return storage(useShallow((state) => state.settings[name]));
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
