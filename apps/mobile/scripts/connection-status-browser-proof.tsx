import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ConnectionStatus } from '../sources/components/buzz/ConnectionStatus';
import { RoomListToolbar } from '../sources/components/buzz/RoomListToolbar';
import { RoomListSectionHeader } from '../sources/components/buzz/RoomListSectionHeader';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { ChannelHeaderTitle } from '../sources/components/buzz/ChannelHeaderTitle';

const now = Date.now();
const savedRoom = {
  room: { id: 'saved-room', name: 'Product', updatedAt: now / 1000 - 120 },
  latestMessage: {
    text: 'The saved Room preview stays readable while Beeline reconnects.',
    createdAt: now / 1000 - 120,
    author: { pubkey: 'jellybean', name: 'Jellybean', handle: 'jellybean' },
  },
};

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  const { theme } = useUnistyles();
  const t = theme.buzz;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.bgBase,
        width: 360,
        minHeight: 360,
      }}
    >
      <Text style={{ ...t.type.sectionHead, color: t.textPrimary, padding: 12 }}>{title}</Text>
      {children}
    </View>
  );
}
function RoomListScreen() {
  const { theme } = useUnistyles();
  const t = theme.buzz;
  return (
    <Frame title="Rooms">
      <RoomListToolbar
        filter="all"
        onFilter={() => undefined}
        query=""
        onQuery={() => undefined}
        counts={{ all: 1, unread: 0, pinned: 0 }}
      />
      <ConnectionStatus />
      <RoomListSectionHeader title="Rooms" count={1} />
      <ConversationRow
        item={savedRoom as any}
        viewer="viewer"
        now={now}
        onPress={() => undefined}
        onPin={() => undefined}
        testID="saved-room-row"
      />
      <Text
        testID="saved-list-content"
        style={{ ...t.type.meta, color: t.ledgerQuiet, padding: 12 }}
      >
        Saved Room list content
      </Text>
    </Frame>
  );
}
function RoomScreen() {
  const { theme } = useUnistyles();
  const t = theme.buzz;
  return (
    <Frame title="Room">
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingBottom: 12,
        }}
      >
        <ChannelHeaderTitle kind="room" title="Product" />
      </View>
      <ConnectionStatus />
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ ...t.type.meta, color: t.ledgerQuiet }}>JELLYBEAN · 9:41</Text>
        <Text testID="saved-room-content" style={{ ...t.type.body, color: t.textPrimary }}>
          The saved transcript stays visible while Beeline reconnects.
        </Text>
      </View>
    </Frame>
  );
}
function Proof() {
  return (
    <View style={{ padding: 12, gap: 16 }}>
      {['Connected', 'Connecting', 'Not connected'].map((state) => (
        <View key={state} style={{ gap: 8 }}>
          <Text style={{ fontSize: 16, fontWeight: '700' }}>{state}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            <RoomListScreen />
            <RoomScreen />
          </View>
        </View>
      ))}
    </View>
  );
}
createRoot(document.getElementById('root')!).render(<Proof />);
setTimeout(() => {
  try {
    const get = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
    if (get('saved-list-content').length !== 3 || get('saved-room-content').length !== 3)
      throw Error('Saved content was not retained on every real-surface fixture.');
    if (get('connection-status-connecting').length !== 2)
      throw Error('Connecting status was not visible on both surfaces.');
    if (get('connection-status-disconnected').length !== 2)
      throw Error('Disconnected status was not visible on both surfaces.');
    const reconnect = get('connection-status-reconnect') as HTMLElement[];
    if (reconnect.length !== 2)
      throw Error('Reconnect was not visible on both disconnected surfaces.');
    reconnect.forEach((button) => button.click());
    if ((window as any).__reconnects !== 2)
      throw Error('Reconnect did not call reconnect-now for both visible controls.');
    document.getElementById('result')!.textContent =
      'PASS: actual Room list and Room fixtures retain saved content in connected, connecting, and disconnected states; Reconnect calls reconnect-now.';
  } catch (error) {
    document.getElementById('result')!.textContent = String(error);
  }
}, 500);
