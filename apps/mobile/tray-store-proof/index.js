import { registerRootComponent } from 'expo';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { useNeedsYouCount, useTrayList, loadTrayList, acknowledgePaintedNeedsYou } from '../sources/buzz/needs-you-store';
import { NeedsYouCell } from '../sources/components/buzz/NeedsYouCell';
import { beelineThemes } from '../sources/buzz/groknight';
import { requests } from './adapters';
const theme = beelineThemes.obsidian;
function App() {
  const [open, setOpen] = useState(false);
  const [opens, setOpens] = useState(0);
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
      <Pressable accessibilityLabel="Open Tray" onPress={async () => {
        if (open) { setOpen(false); return; }
        await loadTrayList('ws'); setOpens(value => value + 1); setOpen(true);
      }}>
        <Text style={{ ...theme.type.hero, color: theme.textPrimary }}>Tray · {count} need you</Text>
        <Text style={{ ...theme.type.body, color: theme.textSecondary }}>{open ? 'Close Tray' : opens ? 'Reopen Tray →' : 'Open Tray →'}</Text>
      </Pressable>
      {open && <Text style={{ ...theme.type.sectionHead, color: theme.textPrimary }}>Needs you · {needs?.length ?? 0} rows</Text>}
    </View>
    {open && <View onLayout={() => {
      requestAnimationFrame(() => {
        if (typeof acknowledgePaintedNeedsYou === 'function')
          void acknowledgePaintedNeedsYou('ws', needs?.map(item => item.messageId) ?? []);
      });
    }}>{needs?.length ? needs.map(item => <NeedsYouCell key={item.messageId} item={item} now={Date.now()}
      desktop={false} onOpen={() => {}} onDismiss={() => {}} />)
      : <Text style={{ ...theme.type.body, color: theme.textSecondary, margin: 20 }}>Nothing needs you</Text>}</View>}
    <Text style={{ ...theme.type.meta, color: theme.textSecondary, margin: 20 }}>{opens > 1 ? 'Reopened' : open ? 'First open' : 'Closed'} · Requests ({requests.length}): {requests.join('\n')}</Text>
  </ScrollView>;
}
registerRootComponent(App);
