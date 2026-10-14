import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import {
  boneTheme,
  boneSmallTheme,
  boneLargeTheme,
  obsidianTheme,
  obsidianSmallTheme,
  obsidianLargeTheme,
} from '../sources/theme';
import {
  GitHubEventCard,
  DaemonFactCard,
  NotificationLifecycleCard,
} from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
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
import { lifecycleFixtures } from './lifecycle-card-fixtures';
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const [index, setIndex] = useState(0);
  const fixture = lifecycleFixtures[index];
  const [result, setResult] = useState('Tap actions to verify their destinations');
  const { theme } = useUnistyles();
  if (!loaded) return null;
  const props = {
    onOpenCorner: (id: string) => setResult(`Corner: ${id}`),
    onOpenUrl: (url: string) => setResult(`View: ${url}`),
  };
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.buzz.bgBase }}
      contentContainerStyle={{ padding: 16, paddingTop: 48, gap: 16 }}
    >
      <View style={{ flexDirection: 'row', gap: 24 }}>
        {(['bone', 'obsidian'] as const).map((name) => (
          <Pressable
            key={name}
            accessibilityLabel={name}
            onPress={() => UnistylesRuntime.setTheme(name)}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ ...theme.buzz.type.body, color: theme.buzz.textPrimary }}>{name}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 24 }}>
        <Pressable
          accessibilityLabel="Previous variant"
          onPress={() =>
            setIndex((index + lifecycleFixtures.length - 1) % lifecycleFixtures.length)
          }
        >
          <Text style={{ color: theme.buzz.textPrimary }}>Previous</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Next variant"
          onPress={() => setIndex((index + 1) % lifecycleFixtures.length)}
        >
          <Text style={{ color: theme.buzz.textPrimary }}>Next</Text>
        </Pressable>
      </View>
      <Text
        accessibilityLabel={`Variant ${fixture.name}`}
        style={{ ...theme.buzz.type.meta, color: theme.buzz.textSecondary }}
      >
        {fixture.name}
      </Text>
      <View key={fixture.name}>
        {fixture.message.notificationLifecycleRun ? (
          <NotificationLifecycleCard message={fixture.message} {...props} />
        ) : fixture.message.githubEvent ? (
          <GitHubEventCard message={fixture.message} onOpenUrl={props.onOpenUrl} />
        ) : (
          <DaemonFactCard message={fixture.message} {...props} />
        )}
      </View>
      <Text
        accessibilityLabel={result}
        style={{ ...theme.buzz.type.meta, color: theme.buzz.textPrimary }}
      >
        {result}
      </Text>
    </ScrollView>
  );
}
registerRootComponent(Proof);
