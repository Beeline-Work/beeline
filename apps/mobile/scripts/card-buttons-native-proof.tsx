import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import {
  boneTheme,
  obsidianTheme,
  boneSmallTheme,
  boneLargeTheme,
  obsidianSmallTheme,
  obsidianLargeTheme,
} from '../sources/theme';
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
import { CoreCardScenes } from './card-button-fixtures';
import { Button } from '../sources/components/buzz/Button';
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const { theme } = useUnistyles();
  const [busy, setBusy] = useState(false);
  if (!loaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ScrollView
        style={{ backgroundColor: theme.buzz.bgBase }}
        contentContainerStyle={{ padding: 16, paddingTop: 48, gap: 16 }}
      >
        <View style={{ flexDirection: 'row', gap: 16 }}>
          {(['bone', 'obsidian'] as const).map((name) => (
            <Button
              key={name}
              label={name}
              variant="secondary"
              onPress={() => UnistylesRuntime.setTheme(name)}
            />
          ))}
        </View>
        <Button label="Toggle busy" variant="secondary" onPress={() => setBusy(!busy)} />
        <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.textPrimary }}>
          System DM grant and tray · R1 / R2 · native fixture
        </Text>
        <CoreCardScenes busy={busy} />
      </ScrollView>
    </GestureHandlerRootView>
  );
}
registerRootComponent(Proof);
