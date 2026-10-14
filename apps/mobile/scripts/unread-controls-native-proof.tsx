import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native-unistyles';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../sources/theme';
import { RoomUnreadControls } from '../sources/components/buzz/RoomUnreadControls';
import { RoomMessageCell } from '../sources/buzz/room-message-cell';
import { ledgerStamp } from '../sources/buzz/relative-time';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';

StyleSheet.configure({ themes: { bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme, obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme }, settings: { initialTheme: 'obsidian' } });
const ruby = { pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby', handle: 'ruby' };
const messages: ChatDisplayMessage[] = [
  { id: 'read', timestamp: Date.parse('2026-10-14T19:20:00Z') / 1000, text: 'Earlier read history.', isUser: false, authorIdentity: ruby },
  { id: 'first', timestamp: Date.parse('2026-10-14T19:26:00Z') / 1000, text: 'The Android verification passed.', isUser: false, authorIdentity: ruby },
  { id: 'second', timestamp: Date.parse('2026-10-14T19:32:00Z') / 1000, text: 'The release is ready for its checks.', isUser: false, authorIdentity: ruby },
  { id: 'last', timestamp: Date.parse('2026-10-14T19:45:00Z') / 1000, text: 'I will report the result after review.', isUser: false, authorIdentity: ruby },
];
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  const theme = obsidianTheme.buzz;
  return <View style={{ flex: 1, backgroundColor: theme.bgBase, paddingTop: 60, paddingHorizontal: 24 }}>
    <StatusBar barStyle="light-content" />
    <Text style={{ ...theme.type.hero, color: theme.textPrimary }}>Ruby</Text>
    <Text style={{ ...theme.type.meta, color: theme.textSecondary }}>Isolated DM fixture · 3 unread agent messages</Text>
    {messages.map((message, index) => <RoomMessageCell key={message.id} item={message} continued={false}
      immediatelyPrecedingMessage={messages[index - 1]} startsNewMessages={message.id === 'first'}
      render={(item) => <View style={{ marginVertical: 16 }}>
        <Text style={{ ...theme.type.body, color: theme.textPrimary }}>{item.text}</Text>
        <Text style={{ ...theme.type.meta, color: theme.textSecondary }}>{ledgerStamp(item.timestamp)}</Text>
      </View>} />)}
    <RoomUnreadControls corner={false} badgeCount={3} discVisible onJumpToNewest={() => {}} />
  </View>;
}
function Root() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><Proof /></SafeAreaProvider></GestureHandlerRootView>;
}
registerRootComponent(Root);
