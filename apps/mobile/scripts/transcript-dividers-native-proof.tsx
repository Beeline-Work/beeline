import React, { useEffect, useRef, useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
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
import { TranscriptDividersProof } from './transcript-dividers-proof';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { OrdinaryLedgerMessage } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import { beginReplyTarget, type MessageReplyTarget } from '../sources/buzz/message-reply';
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
function ReplyProof() {
  const [arrival, setArrival] = useState(0);
  useEffect(() => { const timer = setInterval(() => setArrival(value => value + 1), 200); return () => clearInterval(timer); }, []);
  const [target, setTarget] = useState<MessageReplyTarget | null>(null);
  const [hydrated, setHydrated] = useState(true);
  const [receipt, setReceipt] = useState('Swipe left to reply');
  const input = useRef<TextInput>(null);
  const { theme } = useUnistyles();
  const row: ChatDisplayMessage = {
    id: 'long-agent', text: ('A long agent message in a busy Room. The reply quote belongs above the composer. ').repeat(8),
    timestamp: arrival + 1, isUser: false, isAgentAuthor: true, pubkey: 'proof-agent',
    authorIdentity: { pubkey: 'proof-agent', name: 'Jellybean', handle: 'jellybean', kind: 'agent' },
    ...(hydrated ? { reference: { channelId: 'proof-room', eventId: 'long-agent', rootId: 'long-agent' } } : {}),
  };
  const copy = { ...theme.buzz.type.meta, color: theme.buzz.textPrimary };
  return <View style={{ padding: 24 }}>
    <Pressable accessibilityLabel="Toggle reply proof" style={{ minHeight: 44 }} onPress={() => { setHydrated(!hydrated); setTarget(null); }}>
      <Text style={copy}>{hydrated ? 'Same-Room proof' : 'No parent proof'}</Text>
    </Pressable>
    <OrdinaryLedgerMessage message={row} participantsHydrated viewerPubkey="viewer" speakerWorking={false}
      continued={false} participantHandles={[]} channelIndex={{ rooms: [], corners: [] }} deliveryFailed={false}
      codeRoomId="proof-room" onChannelReference={() => {}} onCopy={() => {}} onRetry={() => {}} onDismiss={() => {}}
      onForwardToNewCorner={() => setReceipt('Corner action fired')}
      onReply={message => {
        const quote = beginReplyTarget(message, [message], { messageId: message.id, authorName: 'Jellybean', isAgent: true, preview: message.text }, 'proof-room');
        setTarget(quote); setReceipt(quote ? 'Reply quote installed' : 'NULL reply target'); input.current?.focus();
      }} />
    <Text testID="reply-proof-result" style={copy}>{receipt}</Text>
    {target ? <Text testID="reply-proof-quote" style={copy}>↳ {target.authorName} · {target.preview.slice(0, 70)}</Text> : null}
    <TextInput ref={input} accessibilityLabel="Proof composer" placeholder="Write a reply" style={{ ...copy, minHeight: 44 }} />
  </View>;
}
function Proof() {
  const [reply, setReply] = useState(false);
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
      <Pressable accessibilityLabel="Switch proof" style={{ minHeight: 44, paddingHorizontal: 24 }} onPress={() => setReply(!reply)}>
        <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.accent }}>{reply ? 'Show dividers' : 'Show reply swipe'}</Text>
      </Pressable>
      {reply ? <ReplyProof /> : <TranscriptDividersProof />}
    </ScrollView>
  );
}
function Root() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider>
      <Proof />
    </SafeAreaProvider></GestureHandlerRootView>
  );
}
registerRootComponent(Root);
