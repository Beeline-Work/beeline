import { Appearance, Platform } from 'react-native';
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
import { resolveAppAppearance, seedAppAppearanceFromSystem } from './buzz/app-appearance-seed';

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

/** Resolve the selected preference to a palette named for its surface material. */
export function themeNameForAppearance(appearance: LocalSettings['appearance']): AppThemeName {
    return resolveAppAppearance(appearance) === 'light' ? 'bone' : 'obsidian';
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

// Complete the one-time migration before any settings consumers mount.
seedAppAppearanceFromSystem();
const initialSettings = loadLocalSettings();
let currentDisplay = initialSettings;
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

/** The Settings → Appearance toggle's write path: switches the live Unistyles
 *  theme and carries the native root/system chrome along with it, the same
 *  way cold start does. */
export function setAppDisplay(
    appearance: LocalSettings['appearance'],
    uiSize: LocalSettings['uiSize'],
): void {
    currentDisplay = { ...currentDisplay, appearance, uiSize };
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

// The OS remains the authority only while System is selected. Keep the latest
// text size when updating the palette without changing the stored preference.
Appearance.addChangeListener(() => {
    if (currentDisplay.appearance === 'system') {
        setAppDisplay('system', currentDisplay.uiSize);
    }
});

// Subscribe before clearing a native override: that reset can emit a change.
applyEffectiveAndroidLaunchAppearance();
