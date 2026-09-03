import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { obsidianTheme } from './theme';
import * as SystemUI from 'expo-system-ui';

const appThemes = {
    obsidian: obsidianTheme,
};

const breakpoints = {
    xs: 0,
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200,
};

type AppThemes = typeof appThemes;
type AppBreakpoints = typeof breakpoints;

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

StyleSheet.configure({
    settings: {
        initialTheme: 'obsidian',
        CSSVars: true,
    },
    breakpoints,
    themes: appThemes,
});

const rootColor = obsidianTheme.colors.groupped.background;
UnistylesRuntime.setRootViewBackgroundColor(rootColor);
void SystemUI.setBackgroundColorAsync(rootColor);
