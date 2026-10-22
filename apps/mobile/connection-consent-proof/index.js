import { registerRootComponent } from 'expo';
import React from 'react';
import { ScrollView, StatusBar, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { GrantRequestCard } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import { beelineThemes } from '../sources/buzz/groknight';
const theme = beelineThemes.bone;
const owner = { pubkey: 'a'.repeat(64), kind: 'human', name: 'Alex' };
const message = { id: 'r1-foreign-connection', timestamp: Date.now(), grantRequest: {
  agent: { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Jellybean' }, owner,
  requester: { pubkey: 'c'.repeat(64), kind: 'human', name: 'Sam' },
  grants: [{ grantId: 'r1', kind: 'mcp', target: 'connection-install:github', appName: 'GitHub',
    reason: 'Connect GitHub', status: 'pending', requestedBy: owner,
    roomId: '22222222-2222-4222-8222-222222222222', createdAt: 1, auto: false }],
} };
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return <GestureHandlerRootView style={{ flex: 1 }}><StatusBar barStyle="dark-content" />
    <ScrollView style={{ flex: 1, backgroundColor: theme.bgBase }} contentContainerStyle={{ paddingTop: 64 }}>
      <View style={{ padding: 16 }}><Text style={{ ...theme.type.hero, color: theme.textPrimary }}>System</Text>
      <Text style={{ ...theme.type.meta, color: theme.textSecondary }}>Other person's agent · R1 fixture</Text></View>
      <GrantRequestCard message={message} viewerIsAgent={false} viewerPubkey={owner.pubkey}
        viewerRole="member" actionId={null} onDecision={() => {}} />
    </ScrollView></GestureHandlerRootView>;
}
registerRootComponent(Proof);
