import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { useFonts } from 'expo-font';
import { boneTheme, obsidianTheme } from '../../../sources/theme';
StyleSheet.configure({
  themes: { bone: boneTheme, obsidian: obsidianTheme },
  settings: { initialTheme: 'bone' },
});
const { RepositoryLifecycleRow } = require('../../../sources/components/buzz/PrLifecycleCard');
function Proof() {
  const { theme } = useUnistyles();
  const [destination, setDestination] = useState('');
  const [ready] = useFonts({
    'SpaceGrotesk-Regular': require('../../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
  });
  if (!ready) return null;
  return (
    <View
      style={{ flex: 1, backgroundColor: theme.buzz.bgBase, padding: 16, paddingTop: 80, gap: 24 }}
    >
      <View style={{ flexDirection: 'row', gap: 24 }}>
        {['bone', 'obsidian'].map((t) => (
          <Pressable key={t} accessibilityLabel={t} onPress={() => UnistylesRuntime.setTheme(t)}>
            <Text style={{ color: theme.buzz.textPrimary }}>{t}</Text>
          </Pressable>
        ))}
      </View>
      {[
        'corner-glyph-alignment',
        'mock-embedded-fonts',
        'a-long-corner-name-that-must-truncate-without-moving-either-icon',
      ].map((title, i) => (
        <RepositoryLifecycleRow
          key={title}
          item={{
            id: String(i),
            title,
            kind: 'corner',
            kindLine: 'corner',
            state: 'Opened',
            cornerId: title,
            actor: '',
            updatedBy: '',
          }}
          onOpenCorner={setDestination}
          onOpenUrl={() => {}}
        />
      ))}
      <Text testID="destination" style={{ color: theme.buzz.textPrimary }}>
        {destination}
      </Text>
    </View>
  );
}
registerRootComponent(Proof);
