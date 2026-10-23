/** Disposable Android fixture for the production approval card. */
import 'react-native-get-random-values';
import React from 'react';
import { registerRootComponent } from 'expo';
import { LogBox, View, Text } from 'react-native';
import { useFonts } from 'expo-font';
require('../sources/unistyles');
import { SquireApprovalCard } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
LogBox.ignoreAllLogs();
const message = {
  id: 'proof',
  timestamp: 1792760000,
  squireApproval: {
    agent: { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Jellybean', handle: 'jellybean' },
    tool: 'fetch_credential',
    title: 'Credential access approval',
    detail: 'Reveal test credential',
    approvalUrl: 'https://approve.example.test/test',
    approvalId: 'proof',
    linkKind: 'approval',
    sourceRoomId: 'proof-room',
    sourceMessageId: 'proof-request',
  },
} as ChatDisplayMessage;
function Proof() {
  const [fonts] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  return fonts ? (
    <View style={{ flex: 1, backgroundColor: '#14091A', paddingTop: 80, paddingHorizontal: 16 }}>
      <Text
        style={{
          color: '#f0f0f3',
          fontFamily: 'SpaceGrotesk-Medium',
          fontSize: 22,
          marginBottom: 24,
        }}
      >
        System
      </Text>
      <SquireApprovalCard message={message} onOpenSource={() => {}} />
    </View>
  ) : null;
}
registerRootComponent(Proof);
