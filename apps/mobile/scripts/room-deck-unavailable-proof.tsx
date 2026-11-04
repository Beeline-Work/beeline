import { PageHeader } from '@/components/buzz/PageHeader';
import { IndexRow } from '@/components/buzz/IndexRow';
import React from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom without declarations.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ConnectionStatus } from '../sources/components/buzz/ConnectionStatus';

const before = new URLSearchParams(location.search).has('before');
function Proof() {
  const { theme } = useUnistyles();
  return <View style={{ width: 390, height: 844, backgroundColor: theme.buzz.bgBase }}>
    {before ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingTop: 40 }}>
      <ConnectionStatus />
    </View> : <View style={[{ flex: 1 },{ paddingTop: 40, paddingBottom: 32 }]} testID="room-deck-unavailable"><PageHeader eyebrow="Beeline" title="Rooms" prominent /><View style={{ paddingHorizontal: theme.buzz.roomList.edge }}><IndexRow inset="flush" title="Beeline couldn’t connect" description="Your Rooms can’t load right now. There are no saved messages on this device yet." action="Reconnect" onPress={() => { (window as any).__reconnects = ((window as any).__reconnects ?? 0) + 1; }} testID="room-deck-reconnect" /></View></View>}
  </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
