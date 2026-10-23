import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, ScrollView, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import {
  boneTheme,
  boneSmallTheme,
  boneLargeTheme,
  obsidianTheme,
  obsidianSmallTheme,
  obsidianLargeTheme,
} from '../sources/theme';
import { DisclosureRowsProof } from './disclosure-rows-proof';

StyleSheet.configure({
  themes: {
    bone: boneTheme,
    boneSmall: boneSmallTheme,
    boneLarge: boneLargeTheme,
    obsidian: obsidianTheme,
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
  const { theme } = useUnistyles();
  if (!loaded) return null;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.buzz.bgBase }}
      contentContainerStyle={{ paddingTop: 48 }}
    >
      <Pressable
        accessibilityLabel="Switch theme"
        style={{ minHeight: 44, paddingHorizontal: 24, justifyContent: 'center' }}
        onPress={() =>
          UnistylesRuntime.setTheme(UnistylesRuntime.themeName === 'bone' ? 'obsidian' : 'bone')
        }
      >
        <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.accent }}>Switch theme</Text>
      </Pressable>
      <DisclosureRowsProof />
    </ScrollView>
  );
}
function Root() {
  return (
    <SafeAreaProvider>
      <Proof />
    </SafeAreaProvider>
  );
}
registerRootComponent(Root);
