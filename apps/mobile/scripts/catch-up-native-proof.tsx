import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { StyleSheet } from 'react-native-unistyles';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../sources/theme';
import { RoomCatchUpSheet } from '../sources/components/buzz/RoomCatchUpSheet';
import { Button } from '../sources/components/buzz/Button';
import { buildCatchUpReport, catchUpClock } from '../sources/buzz/room-catch-up-report';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';

StyleSheet.configure({ themes: { bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme, obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme }, settings: { initialTheme: 'obsidian' } });
const ruby = { pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby', handle: 'ruby' };
const messages: ChatDisplayMessage[] = [
  { id: 'read', timestamp: Date.parse('2026-10-14T19:20:00Z') / 1000, text: 'Earlier read history.', isUser: false, authorIdentity: ruby },
  { id: 'first', timestamp: Date.parse('2026-10-14T19:26:00Z') / 1000, text: 'The Catch up fix merged and Android verification passed.', isUser: false, authorIdentity: ruby },
  { id: 'decision', timestamp: Date.parse('2026-10-14T19:32:00Z') / 1000, text: 'We decided to retry the release after the build cache refresh.', isUser: false, authorIdentity: ruby },
  { id: 'last', timestamp: Date.parse('2026-10-14T19:45:00Z') / 1000, text: 'The release failed because the build timed out.', isUser: false, authorIdentity: ruby },
];

function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const [visible, setVisible] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const report = buildCatchUpReport({ messages, boundaryId: 'first', newestId: 'last', viewerPubkey: 'owner' });
  if (!loaded) return null;
  return <View style={{ flex: 1, backgroundColor: obsidianTheme.buzz.bgBase, paddingTop: 60, paddingHorizontal: 24 }}>
    <StatusBar barStyle="light-content" />
    <Text style={{ ...obsidianTheme.buzz.type.hero, color: obsidianTheme.buzz.textPrimary }}>Ruby</Text>
    <Text style={{ ...obsidianTheme.buzz.type.meta, color: obsidianTheme.buzz.textSecondary }}>Isolated DM fixture · three unread agent messages</Text>
    {messages.map((message) => <View key={message.id} style={{ marginTop: 16 }}>
      {message.id === 'first' && <Text style={{ color: obsidianTheme.buzz.textSecondary }}>NEW</Text>}
      <Text style={{ ...obsidianTheme.buzz.type.body, color: obsidianTheme.buzz.textPrimary }}>{message.text}</Text>
      <Text style={{ ...obsidianTheme.buzz.type.meta, color: obsidianTheme.buzz.textSecondary }}>{catchUpClock(message.timestamp)}</Text>
    </View>)}
    <Button label="Open catch up" onPress={() => { setUnavailable(false); setVisible(true); }} />
    <Button label="Show unavailable summary" onPress={() => { setUnavailable(true); setVisible(true); }} />
    <RoomCatchUpSheet agents={[ruby]} canDraft onAskAgent={() => setVisible(false)} onClose={() => setVisible(false)}
      onRetry={() => setUnavailable(false)} report={unavailable && report ? { ...report, summary: null } : report} visible={visible} />
  </View>;
}
function Root() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><KeyboardProvider><Proof /></KeyboardProvider></SafeAreaProvider></GestureHandlerRootView>;
}
registerRootComponent(Root);
