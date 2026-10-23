import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { DesktopRoomCorners } from '../sources/components/buzz/DesktopRoomCorners';
import { applyChatListCorners } from '../sources/buzz/room-corner-store';
// @ts-expect-error The proof runner provides server-projected fixtures.
import rooms from 'ci-proof-data';
applyChatListCorners(rooms, Date.now());
function Proof() {
  const { theme } = useUnistyles();
  return (
    <View style={{ backgroundColor: theme.buzz.bgBase, minHeight: '100vh' as any, width: 440 }}>
      <Text style={{ ...theme.buzz.type.body, color: theme.buzz.textPrimary, padding: 16 }}>
        Beeline · Rooms
      </Text>
      {rooms.map((item: any) => (
        <View key={item.room.id}>
          <ConversationRow
            item={item}
            viewer="owner"
            now={Date.now()}
            desktop
            onPress={() => {}}
            onPin={() => {}}
            testID={`room-${item.room.id}`}
          />
          <DesktopRoomCorners item={item} onOpen={() => {}} />
        </View>
      ))}
    </View>
  );
}
createRoot(document.getElementById('root')!).render(<Proof />);
setTimeout(() => {
  document.getElementById('result')!.textContent = JSON.stringify(
    rooms.map((room: any) => ({
      room: room.room.name,
      waiting: room.waitingCornerCount,
      state: room.openCorners[0].state,
    })),
  );
}, 500);
