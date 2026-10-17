/** Isolated Android proof using the production composer, ledger hint and local-send hook. */
import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { beelineThemes } from '../sources/buzz/groknight';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../sources/theme';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import { OrdinaryLedgerMessage } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useUntaggedMessageHints } from '../sources/buzz/use-untagged-message-hints';
import { resolveComposerMentions } from '../sources/buzz/room-participants';

StyleSheet.configure({ themes: { bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme,
  obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme },
  settings: { initialTheme: 'bone' } });
const participants = [
  { pubkey: 'agent', handle: 'ruby', name: 'Ruby' },
  { pubkey: 'person', handle: 'avery', name: 'Avery' },
];
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const [dark, setDark] = useState(false);
  const [mode, setMode] = useState('Room');
  const [active, setActive] = useState(true);
  const [value, setValue] = useState('');
  const [messages, setMessages] = useState<{ id: string; text: string }[]>([]);
  const options = { roomId: mode, viewerKind: 'human' as const, hasAgentMembers: mode !== 'No agents',
    isDirectMessage: mode === 'DM', active };
  const sender = useUntaggedMessageHints({ ...options, viewerPubkey: 'sender' });
  const observer = useUntaggedMessageHints({ ...options, viewerPubkey: 'observer' });
  const theme = dark ? beelineThemes.obsidian : beelineThemes.bone;
  const send = (text: string) => {
    if (!text.trim() || !active) return;
    const id = `send-${messages.length + 1}`;
    const record = sender.captureSend(resolveComposerMentions(text, participants, new Map()).pubkeys.length > 0);
    // Simulated successful receipt; no identity, transport or server is used.
    setMessages(current => [...current, { id, text }]);
    record(id);
    setValue('');
  };
  if (!loaded) return null;
  return <ScrollView style={{ flex: 1, backgroundColor: theme.bgBase }}
    contentContainerStyle={{ padding: 16, paddingTop: 64, paddingBottom: 64, gap: 16 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {[
        ['Untagged', () => send('Hello Room')],
        ['Tag person', () => send('@avery hello')],
        ['Tag agent', () => send('@ruby hello')],
        ...['Room', 'Corner', 'DM', 'No agents'].map(next => [next, () => { setMode(next); setMessages([]); }]),
        ['Leave / return', () => setActive(!active)],
        ['Toggle theme', () => { UnistylesRuntime.setTheme(dark ? 'bone' : 'obsidian'); setDark(!dark); }],
      ].map(([label, action]) => <Pressable key={label as string} accessibilityLabel={label as string}
        onPress={action as () => void} style={{ padding: 8, borderWidth: 1, borderColor: theme.borderStrong }}>
        <Text style={{ color: theme.textPrimary }}>{label as string}</Text>
      </Pressable>)}
    </View>
    <Text style={{ color: theme.textPrimary }}>{mode === 'Room' ? '#general' : mode} · {active ? 'viewing' : 'left'}</Text>
    {[
      { title: 'Sender device', hints: sender.hintMessageIds },
      { title: 'Second account device', hints: observer.hintMessageIds },
    ].map(({ title, hints }) => <View key={title} style={{ gap: 8 }}>
      <Text style={{ color: theme.accent }}>{title}</Text>
      {messages.map(message => <OrdinaryLedgerMessage key={message.id}
        message={{ ...message, timestamp: 1, pubkey: 'sender', isUser: title === 'Sender device',
          authorIdentity: { pubkey: 'sender', kind: 'human', name: 'Sender' } }}
        viewerPubkey={title === 'Sender device' ? 'sender' : 'observer'}
        participantsHydrated speakerWorking={false} continued={false}
        participantHandles={participants} channelIndex={{ rooms: [], corners: [] }}
        untaggedHint={hints.has(message.id)} deliveryFailed={false}
        onChannelReference={() => {}} onReply={() => {}} onCopy={() => {}}
        onRetry={() => {}} onDismiss={() => {}} />)}
    </View>)}
    <ConversationComposer value={value} height={26} focused={false} disabled={!active}
      isDirectMessage={options.isDirectMessage} hasAgentMembers={options.hasAgentMembers} speechEnabled={false}
      onBlur={() => {}} onFocus={() => {}} onKeyPress={() => {}}
      onChangeText={setValue} onSend={() => send(value)} onContentSizeChange={() => {}} />
  </ScrollView>;
}
registerRootComponent(() => <GestureHandlerRootView style={{ flex: 1 }}><Proof /></GestureHandlerRootView>);
