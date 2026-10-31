// Production Ledger and IdentityMark, fed by members created through real OAuth.
import { registerRootComponent } from 'expo';
import React from 'react';
import { View, Text } from 'react-native';
import { useFonts } from 'expo-font';
import { LedgerBylineView } from '../sources/components/buzz/Ledger';
import { beelineThemes } from '../sources/buzz/groknight';
import members from '../evidence/mcp-default-pictures/members.json';
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  const theme = beelineThemes.bone;
  return <View style={{ flex: 1, backgroundColor: theme.bgBase, padding: 24, paddingTop: 64 }}>
    <Text style={{ ...theme.type.hero, color: theme.textPrimary, marginBottom: 32 }}>connector-demo</Text>
    {members.map(member => <View key={member.pubkey} style={{ marginBottom: 24 }}>
      <LedgerBylineView byline={{ name: member.name, role: 'AGENT', stamp: '10:18', mark: { kind: 'agent', seed: member.pubkey, avatarUrl: member.avatarUrl } }} />
      <Text style={{ ...theme.type.body, color: theme.textPrimary, marginTop: 8 }}>{member.name} connected with the default app picture.</Text>
    </View>)}
  </View>;
}
registerRootComponent(Proof);
