import React from 'react';
// @ts-expect-error Browser proof dependencies have no local declarations.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useUnistyles } from 'react-native-unistyles';
import { OrdinaryLedgerMessage } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';

// Reproduction R1 stand-in: phone transcript rows that offer both swipe panels.
const rows: ChatDisplayMessage[] = [
  {
    id: 'human', timestamp: 1_790_000_000, isUser: false, pubkey: 'proof-human',
    authorIdentity: { pubkey: 'proof-human', name: 'lunchboxfortwo', handle: 'lunchboxfortwo', kind: 'human' },
    text: '@ruby … Right, so in terms of who owns a vault, I don’t understand why there needs to be separate vaults for each of their end users. And that’s because the entire point of having a vault is to deny those individual app developers access to their customers’ vaults. Check these 4 gaps against the Squire code and write a short gap list, what exists, what’s missing and rough size.',
  },
  {
    id: 'agent', timestamp: 1_790_000_060, isUser: false, isAgentAuthor: true, pubkey: 'proof-agent',
    authorIdentity: { pubkey: 'proof-agent', name: 'Ruby', handle: 'ruby', kind: 'agent' },
    text: 'Default (recommended): one vault per customer account, with approvals inside the customer’s product.',
  },
];

function Scene() {
  const { theme } = useUnistyles();
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.buzz.bgBase }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        {rows.map((row) => (
          <OrdinaryLedgerMessage
            key={row.id} message={row} desktopLayout={false} participantsHydrated viewerPubkey="viewer"
            speakerWorking={false} continued={false} participantHandles={[]}
            channelIndex={{ rooms: [], corners: [] }} deliveryFailed={false}
            onChannelReference={() => {}} onReply={() => {}} onForwardToNewCorner={() => {}}
            onCopy={() => {}} onRetry={() => {}} onDismiss={() => {}}
          />
        ))}
      </View>
    </GestureHandlerRootView>
  );
}

createRoot(document.getElementById('root')!).render(<Scene />);
