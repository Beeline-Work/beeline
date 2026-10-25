import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { StyleSheet } from 'react-native-unistyles';
import {
  boneTheme,
  obsidianTheme,
  boneSmallTheme,
  boneLargeTheme,
  obsidianSmallTheme,
  obsidianLargeTheme,
} from '../sources/theme';
import LifecycleGlyphProof from './lifecycle-glyph-proof';
StyleSheet.configure({
  themes: {
    bone: boneTheme,
    obsidian: obsidianTheme,
    boneSmall: boneSmallTheme,
    boneLarge: boneLargeTheme,
    obsidianSmall: obsidianSmallTheme,
    obsidianLarge: obsidianLargeTheme,
  },
  settings: { initialTheme: 'bone' },
});
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  return loaded ? <LifecycleGlyphProof /> : null;
}
registerRootComponent(Proof);
