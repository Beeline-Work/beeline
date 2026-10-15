import React, { useState } from 'react';
import { useFonts } from 'expo-font';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { LedgerEntry, LedgerSystemLine } from '../sources/components/buzz/Ledger';
import { displayRoomMessage } from '../sources/buzz/room-view-presentation';
import messages from './messages.json';

// The JSON is produced by PhoneService.readRoom from legacy stored cards.
export default function Proof() {
  const [after, setAfter] = useState(false);
  const { theme } = useUnistyles();
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return <View style={{ flex: 1, backgroundColor: theme.buzz.bgBase, padding: 20, paddingTop: 70 }}>
    <Pressable accessibilityLabel="Toggle before and after" onPress={() => setAfter(!after)}>
      <Text style={{ ...theme.buzz.type.body, color: theme.buzz.textPrimary, marginBottom: 40 }}>{after ? 'After' : 'Before'} · System notices</Text>
    </Pressable>
    {messages.map((wire) => {
      const message = displayRoomMessage({ ...wire, presentation: after ? wire.presentation : 'card' } as any, 'viewer');
      return <View key={message.id} style={{ marginBottom: 28 }}>
        {message.isSystemNotice
          ? <LedgerSystemLine id={message.id} text={message.text} event={message.systemEvent} stamp="11:22" />
          : <LedgerEntry itemId={message.id} bodyText={message.text} bodyTestID={message.id}
              byline={{ name: 'System', stamp: '11:22' }} />}
      </View>;
    })}
  </View>;
}
