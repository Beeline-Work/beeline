import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { editorialTheme, ledgerTheme, obsidianTheme } from './theme';
import { loadThemePreference } from './sync/persistence';
import * as SystemUI from 'expo-system-ui';

const appThemes = {
    obsidian: obsidianTheme,
    editorial: editorialTheme,
    ledger: ledgerTheme,
};

const breakpoints = {
    xs: 0,
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200,
};

const themePreference = loadThemePreference();

type AppThemes = typeof appThemes;
type AppBreakpoints = typeof breakpoints;

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

StyleSheet.configure({
    settings: {
        initialTheme: themePreference,
        CSSVars: true,
    },
    breakpoints,
    themes: appThemes,
});

const rootColor = appThemes[themePreference].colors.groupped.background;
UnistylesRuntime.setRootViewBackgroundColor(rootColor);
void SystemUI.setBackgroundColorAsync(rootColor);
