import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { obsidianTheme } from './theme';
import * as SystemUI from 'expo-system-ui';
import { LAYOUT_BREAKPOINTS } from './utils/layoutClass';

const appThemes = {
    obsidian: obsidianTheme,
};

const breakpoints = LAYOUT_BREAKPOINTS;

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
