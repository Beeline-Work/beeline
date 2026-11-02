import React from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom without declarations.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ConnectionStatus } from '../sources/components/buzz/ConnectionStatus';
import { RoomDeckUnavailableView } from '../sources/components/buzz/RoomDeckUnavailableView';

const before = new URLSearchParams(location.search).has('before');
function Proof() {
  const { theme } = useUnistyles();
  return <View style={{ width: 390, height: 844, backgroundColor: theme.buzz.bgBase }}>
    {before ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingTop: 40 }}>
      <ConnectionStatus />
    </View> : <RoomDeckUnavailableView
      style={{ paddingTop: 40, paddingBottom: 32 }}
      onReconnect={() => { (window as any).__reconnects = ((window as any).__reconnects ?? 0) + 1; }}
    />}
  </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
