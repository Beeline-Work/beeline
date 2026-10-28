/** Local fixture for the production message renderer; no account or network access. */
import 'react-native-get-random-values';
import '../sources/unistyles';
import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { ScrollView, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { OrdinaryLedgerMessage } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';

const noop = () => {};
const common = {
  participantsHydrated: true, viewerPubkey: 'viewer', speakerWorking: false,
  participantHandles: [], channelIndex: { rooms: [], corners: [] }, deliveryFailed: false,
  firstBylineOfDay: false, onChannelReference: noop, onReply: noop, onCopy: noop,
  onRetry: noop, onDismiss: noop,
};
const messages: ChatDisplayMessage[] = [
  { id: 'muse', pubkey: 'muse', text: 'The app name belongs in the model label.',
    isUser: false, timestamp: 1793199480, isAgentAuthor: true, agentModel: 'Meta Muse',
    authorIdentity: { kind: 'agent', pubkey: 'muse', name: 'Meta Muse' },
    sourceClient: { id: 'meta-muse', name: 'Meta Muse' } },
  { id: 'renamed', pubkey: 'muse', text: 'A custom profile name keeps the same app label.',
    isUser: false, timestamp: 1793199540, isAgentAuthor: true, agentModel: 'Meta Muse',
    authorIdentity: { kind: 'agent', pubkey: 'muse', name: 'Muse' },
    sourceClient: { id: 'meta-muse', name: 'Meta Muse' } },
  { id: 'person', pubkey: 'person', text: 'A connector message starts a run.',
    isUser: false, timestamp: 1793199600,
    authorIdentity: { kind: 'human', pubkey: 'person', name: 'Alex' },
    sourceClient: { id: 'meta-muse', name: 'Meta Muse' } },
  { id: 'continued', pubkey: 'person', text: 'The next message continues without another header.',
    isUser: false, timestamp: 1793199660,
    authorIdentity: { kind: 'human', pubkey: 'person', name: 'Alex' },
    sourceClient: { id: 'meta-muse', name: 'Meta Muse' } },
];
function Proof() {
  const { theme } = useUnistyles();
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><KeyboardProvider>
    <ScrollView style={{ backgroundColor: theme.buzz.bgBase }} contentContainerStyle={{ padding: 24, paddingTop: 72, gap: 24 }}>
      <Text style={{ ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary }}>#beeline · local message fixture</Text>
      {messages.map((message, index) => <OrdinaryLedgerMessage key={message.id}
        {...common} message={message} agentModel={message.agentModel} continued={index === 3} />)}
    </ScrollView>
  </KeyboardProvider></SafeAreaProvider></GestureHandlerRootView>;
}
UnistylesRuntime.setTheme('obsidian');
registerRootComponent(Proof);
