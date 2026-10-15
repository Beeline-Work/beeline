import { registerRootComponent } from 'expo';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { useNeedsYouCount, useTrayList, loadTrayList } from '../sources/buzz/needs-you-store';
import { NeedsYouCell } from '../sources/components/buzz/NeedsYouCell';
import { beelineThemes } from '../sources/buzz/groknight';
import { requests } from './adapters';
const theme = beelineThemes.obsidian;
function App() {
  const [open, setOpen] = useState(false);
  const count = useNeedsYouCount('ws', 1);
  const { needs } = useTrayList('ws');
  const [fonts] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!fonts) return null;
  return <ScrollView style={{ flex: 1, backgroundColor: theme.bgBase }} contentContainerStyle={{ paddingTop: 80 }}>
    <View style={{ paddingHorizontal: 20, gap: 20 }}>
      <Text style={{ ...theme.type.meta, color: theme.textSecondary }}>TRAY-CACHED-EMPTY-1 · ANDROID</Text>
      <Pressable accessibilityLabel="Open Tray" onPress={async () => { await loadTrayList('ws'); setOpen(true); }}>
        <Text style={{ ...theme.type.hero, color: theme.textPrimary }}>Tray · {count} need you</Text>
        <Text style={{ ...theme.type.body, color: theme.textSecondary }}>Open Tray →</Text>
      </Pressable>
      {open && <Text style={{ ...theme.type.sectionHead, color: theme.textPrimary }}>Needs you · {needs?.length ?? 0} rows</Text>}
    </View>
    {open && (needs?.length ? needs.map(item => <NeedsYouCell key={item.messageId} item={item} now={Date.now()}
      desktop={false} onOpen={() => {}} onDismiss={() => {}} />)
      : <Text style={{ ...theme.type.body, color: theme.textSecondary, margin: 20 }}>Nothing needs you</Text>)}
    <Text style={{ ...theme.type.meta, color: theme.textSecondary, margin: 20 }}>Requests: {requests.join(', ')}</Text>
  </ScrollView>;
}
registerRootComponent(App);
