/** LATER-1: disposable Android transcript using the production history store. */
import 'react-native-get-random-values';
import React, { useState } from 'react';
import { AppRegistry, FlatList, Pressable, Text, View } from 'react-native';
import { RoomViewHttpError, type RoomViewMessage } from '@beeline/buzz-client';
import { useRoomMessageStore, type RoomHistoryClient } from '../sources/buzz/room-message-store';

const messages: RoomViewMessage[] = Array.from({ length: 227 }, (_, index) => ({
  id: (index + 1).toString(16).padStart(64, '0'),
  createdAt: index + 1,
  text: `Message ${index + 1}`,
  presentation: 'message',
  author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
}));
const tail = messages.slice(-30);

function Proof() {
  const [requests, setRequests] = useState<string[]>([]);
  const [client] = useState<RoomHistoryClient>(() => {
    let attempts = 0;
    return {
      history: async () => ({ roomId: 'proof', messages: tail }),
      historyAround: async () => ({ roomId: 'proof', messages: messages.slice(11, 41) }),
      historyAfter: async (_room, cursor) => {
        const status = ++attempts === 1 ? 503 : 404;
        setRequests(current => [...current, `readHistoryAfter …${cursor.slice(-4)}: ${status}`]);
        throw new RoomViewHttpError(status, status === 404 ? 'not_found' : 'unavailable');
      },
    };
  });
  const store = useRoomMessageStore({
    roomId: 'proof', tailMessages: tail, roomClient: client,
    enabled: true, initialVisibleCount: 30,
  });
  const rows = store.attached ? tail : store.rows;
  return <View style={{ flex: 1, padding: 28, paddingTop: 60, backgroundColor: '#ffffff' }}>
    <Text style={{ color: '#111111', fontSize: 22 }}>LATER-1 · Android</Text>
    <Text style={{ color: '#111111' }}>{store.attached ? 'Live tail · Message 227 reachable' : 'Older window · detached'}</Text>
    <Pressable onPress={() => store.jumpTo(messages[26]!.id)} style={{ padding: 12 }}>
      <Text style={{ color: '#0044aa' }}>Open older message 27</Text>
    </Pressable>
    <FlatList data={[...rows].reverse()} inverted keyExtractor={row => row.id}
      renderItem={({ item }) => <Text style={{ color: '#111111', padding: 5 }}>{item.text}</Text>} />
    {!store.attached && <Pressable
      onPress={store.newerStatus === 'error' ? store.retryNewer : store.loadNewer}
      style={{ padding: 16 }}>
      <Text style={{ color: '#0044aa' }}>{store.newerStatus === 'error'
        ? "Couldn't load later messages · tap to retry" : 'Load later messages'}</Text>
    </Pressable>}
    <Text style={{ color: '#111111' }}>{requests.join('\n')}</Text>
  </View>;
}
AppRegistry.registerComponent('main', () => Proof);
