import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../../sources/theme';
import { HeaderAlignmentProof } from './screen';
StyleSheet.configure({ themes: { bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme, obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme }, settings: { initialTheme: 'bone' } });
function Proof() {
  const [theme, setTheme] = useState('bone');
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
  });
  if (!loaded) return null;
  return <HeaderAlignmentProof key={theme} onTheme={() => { const next = theme === 'bone' ? 'obsidian' : 'bone'; UnistylesRuntime.setTheme(next); setTheme(next); }} />;
}
registerRootComponent(Proof);
