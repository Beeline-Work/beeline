import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { boneTheme, obsidianTheme } from './theme';
import * as SystemUI from 'expo-system-ui';
import { LAYOUT_BREAKPOINTS } from './utils/layoutClass';
import type { LocalSettings } from './sync/localSettings';
import { loadLocalSettings } from './sync/persistence';

const appThemes = {
    obsidian: obsidianTheme,
    bone: boneTheme,
};

const breakpoints = LAYOUT_BREAKPOINTS;

type AppThemes = typeof appThemes;
type AppBreakpoints = typeof breakpoints;
export type AppThemeName = keyof AppThemes;

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

/** Settings → Appearance stores 'light' | 'dark'; Unistyles themes are named
 *  after their surface material. Kept as its own function so the mapping is
 *  unit-testable without booting Unistyles. */
export function themeNameForAppearance(appearance: LocalSettings['appearance']): AppThemeName {
    return appearance === 'light' ? 'bone' : 'obsidian';
}

const initialThemeName = themeNameForAppearance(loadLocalSettings().appearance);

StyleSheet.configure({
    settings: {
        initialTheme: initialThemeName,
        CSSVars: true,
    },
    breakpoints,
    themes: appThemes,
});

function applyRootBackground(themeName: AppThemeName): void {
    const rootColor = appThemes[themeName].colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(rootColor);
    void SystemUI.setBackgroundColorAsync(rootColor);
}

applyRootBackground(initialThemeName);

/** The Settings → Appearance toggle's write path: switches the live Unistyles
 *  theme and carries the native root/system chrome along with it, the same
 *  way cold start does. */
export function setAppAppearance(appearance: LocalSettings['appearance']): void {
    const themeName = themeNameForAppearance(appearance);
    UnistylesRuntime.setTheme(themeName);
    applyRootBackground(themeName);
}
