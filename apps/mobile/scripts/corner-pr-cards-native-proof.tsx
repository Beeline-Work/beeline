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
  DaemonFactCard,
  NotificationLifecycleCard,
} from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import { foldPrLifecycleRuns } from '../sources/buzz/pr-lifecycle';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
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
const single: ChatDisplayMessage = {
  id: 'single',
  text: '',
  isUser: false,
  timestamp: 1791991980,
  authorIdentity: { pubkey: 'ruby', kind: 'agent', name: 'Ruby', handle: 'ruby' },
  daemonFact: {
    type: 'corner-complete',
    cornerId: 'single-corner',
    name: 'no-room-broadcast',
    objective: 'Preserve Room broadcasts',
    outcome: 'landed',
    pullRequest: {
      number: 2462,
      title: 'Preserve Room broadcasts',
      url: 'https://github.com/Beeline-Work/beeline/pull/2462',
    },
  },
};
const second: ChatDisplayMessage = {
  ...single,
  id: 'grouped',
  timestamp: 1791996480,
  daemonFact: {
    ...single.daemonFact!,
    cornerId: 'grouped-corner',
    name: 'multiway-call-tags',
    pullRequest: {
      number: 2456,
      title: 'Route multi-human voice',
      url: 'https://github.com/Beeline-Work/beeline/pull/2456',
    },
  },
};
const grouped = foldPrLifecycleRuns([single, second])[0];
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
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
      <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.textSecondary }}>Single PR</Text>
      <DaemonFactCard message={single} {...props} />
      <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.textSecondary }}>Grouped PRs</Text>
      <NotificationLifecycleCard message={grouped} {...props} />
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
