import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { StyleSheet } from 'react-native-unistyles';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../sources/theme';
import { QuietRowActionsScene } from './quiet-row-actions-scene';
StyleSheet.configure({ themes: { bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme, obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme }, settings: { initialTheme: 'bone' } });
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  return loaded ? <QuietRowActionsScene /> : null;
}
registerRootComponent(Proof);
