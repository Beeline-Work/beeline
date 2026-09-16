import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { useUnistyles } from 'react-native-unistyles';

/** Status bar glyph color follows the app theme: dark icons over Bone,
 *  light icons over Obsidian. One mapping so the global provider and the
 *  (app) stack's screenOptions cannot disagree on a platform. */
export function statusBarStyleForTheme(theme: { dark: boolean }): 'light' | 'dark' {
    return theme.dark ? 'light' : 'dark';
}

export const StatusBarProvider = React.memo(() => {
    const { theme } = useUnistyles();
    return (
        <StatusBar style={statusBarStyleForTheme(theme)} animated={true} />
    );
});
