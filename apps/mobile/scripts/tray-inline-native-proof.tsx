/** Native component proof against scripts/prove-tray-inline.ts's isolated Beeline Review. */
import React, { useEffect, useState } from 'react';
import { ScrollView, StatusBar, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts } from 'expo-font';
import type { NeedsYouItemView, NeedsYouActionView } from '@beeline/api-contract/phone';
import { NeedsYouCell } from '../sources/components/buzz/NeedsYouCell';
import { beelineThemes } from '../sources/buzz/groknight';

import { proofTheme } from '../tray-proof/proof-theme';
const groknight = beelineThemes[proofTheme];
const origin = 'http://10.0.2.2:39197';
export default function TrayInlineNativeProof() {
  const [items, setItems] = useState<readonly NeedsYouItemView[]>([]);
  const [status, setStatus] = useState('Loading Beeline Review…');
  const [fonts] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const read = async () => {
    const response = await fetch(`${origin}/needs`);
    if (!response.ok) throw new Error(await response.text());
    const body = await response.json();
    setItems(body.items);
  };
  useEffect(() => { void read().then(() => setStatus('Decide here or open the @System message'), error => setStatus(String(error))); }, []);
  const act = async (item: NeedsYouItemView, action: NeedsYouActionView) => {
    try {
      if (action.kind !== 'grant') throw new Error('This fixture proves grant decisions');
      const response = await fetch(`${origin}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grantId: action.grantId, decision: action.decision }) });
      if (!response.ok) throw new Error(await response.text());
      await read();
      setStatus(`${action.decision === 'deny' ? 'Denied' : 'Approved once'} ${item.approval?.subject} · stayed in the tray`);
    } catch (error) { setStatus(String(error)); }
  };
  if (!fonts) return null;
  return <GestureHandlerRootView style={{ flex: 1, backgroundColor: groknight.bgBase }}>
    <StatusBar barStyle={proofTheme === 'bone' ? 'dark-content' : 'light-content'} />
    <ScrollView contentContainerStyle={{ paddingTop: (StatusBar.currentHeight ?? 24) + 24, paddingBottom: 32 }}>
      <View style={{ paddingHorizontal: 16, marginBottom: 16 }}>
        <Text style={{ ...groknight.type.meta, color: groknight.textSecondary }}>BEELINE REVIEW</Text>
        <Text style={{ ...groknight.type.hero, color: groknight.textPrimary }}>Tray</Text>
        <Text style={{ ...groknight.type.meta, color: groknight.textSecondary, marginTop: 8 }}>{status}</Text>
        <Text style={{ ...groknight.type.sectionHead, color: groknight.textPrimary, marginTop: 24 }}>Needs you {items.length}</Text>
      </View>
      {items.map(item => <NeedsYouCell key={item.messageId} item={item} now={Date.now()} desktop={false}
        onOpen={() => setStatus(`@System · exact message ${item.messageId.slice(0, 12)}`)} onDismiss={() => {}}
        onAction={act} />)}
      {!items.length ? <Text style={{ ...groknight.type.body, color: groknight.textSecondary, margin: 16 }}>Nothing needs you</Text> : null}
    </ScrollView>
  </GestureHandlerRootView>;
}
