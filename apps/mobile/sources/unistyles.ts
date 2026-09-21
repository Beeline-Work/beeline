import { Platform } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import {
    boneLargeTheme,
    boneSmallTheme,
    boneTheme,
    obsidianLargeTheme,
    obsidianSmallTheme,
    obsidianTheme,
} from './theme';
import * as SystemUI from 'expo-system-ui';
import { LAYOUT_BREAKPOINTS } from './utils/layoutClass';
import type { LocalSettings } from './sync/localSettings';
import { loadLocalSettings } from './sync/persistence';
import {
    applyEffectiveAndroidLaunchAppearance,
    pinAndroidLaunchAppearance,
} from './buzz/android-launch-appearance';
import { seedAppAppearanceFromSystem } from './buzz/app-appearance-seed';

const appThemes = {
    obsidian: obsidianTheme,
    obsidianSmall: obsidianSmallTheme,
    obsidianLarge: obsidianLargeTheme,
    bone: boneTheme,
    boneSmall: boneSmallTheme,
    boneLarge: boneLargeTheme,
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

export function themeNameForDisplay(
    appearance: LocalSettings['appearance'],
    uiSize: LocalSettings['uiSize'],
    platform: typeof Platform.OS = Platform.OS,
): AppThemeName {
    const base = themeNameForAppearance(appearance);
    if (platform === 'web' || uiSize === 'medium') return base;
    return `${base}${uiSize === 'small' ? 'Small' : 'Large'}` as AppThemeName;
}

// Seed before anything reads local settings: a first install (or first run
// after an update) replicates the system dark-mode setting instead of the
// hardcoded dark default, so the app and the splash agree from the start.
seedAppAppearanceFromSystem();
const initialSettings = loadLocalSettings();
const initialThemeName = themeNameForDisplay(initialSettings.appearance, initialSettings.uiSize);

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
applyEffectiveAndroidLaunchAppearance();

/** The Settings → Appearance toggle's write path: switches the live Unistyles
 *  theme and carries the native root/system chrome along with it, the same
 *  way cold start does. */
export function setAppDisplay(
    appearance: LocalSettings['appearance'],
    uiSize: LocalSettings['uiSize'],
): void {
    const themeName = themeNameForDisplay(appearance, uiSize);
    UnistylesRuntime.setTheme(themeName);
    applyRootBackground(themeName);
}

export function setAppAppearance(
    appearance: LocalSettings['appearance'],
    uiSize: LocalSettings['uiSize'] = loadLocalSettings().uiSize,
): void {
    setAppDisplay(appearance, uiSize);
}

/** Settings → Appearance only. Text-size changes keep using setAppDisplay so
 *  the live theme and root chrome move without re-pinning the splash. */
export function applyAppearanceChoice(
    appearance: LocalSettings['appearance'],
    uiSize: LocalSettings['uiSize'],
): void {
    setAppDisplay(appearance, uiSize);
    pinAndroidLaunchAppearance(appearance);
}
