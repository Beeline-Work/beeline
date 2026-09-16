import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { useUnistyles } from 'react-native-unistyles';


export const StatusBarProvider = React.memo(() => {
    const { theme } = useUnistyles();
    const statusBarStyle = theme.dark ? 'light' : 'dark';
    // Android's system status tray falls back to the system's white strip,
    // which sits indistinguishably on Bone's cream surface. In light mode
    // give it one darker bone elevation step (bgRaised — the same persistent
    // raised stop code blocks carry) so it reads as its own bar. Dark mode
    // keeps the tray it already has.
    const statusBarBackground = theme.dark ? undefined : theme.buzz.bgRaised;
    return (
        <StatusBar style={statusBarStyle} backgroundColor={statusBarBackground} animated={true} />
    );
});