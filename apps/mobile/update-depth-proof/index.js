import { registerRootComponent } from 'expo';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { IdentitySelection, recordPerson, useIdentityRecords } from '@/buzz/identity-records';
import { stampRoomMessageRows, useRoomMessageRecords, useRoomTurnRecords, writeRoomMessage } from '@/buzz/room-message-records';
import { currentSurfaceStamp, nextSurfaceStamp } from '@/buzz/surface-clock';

const scope = 'update-depth-proof';
const roomId = 'renamed-author-room';
const original = { id: 'message', version: 1, text: 'Room message', createdAt: 1,
  presentation: 'message', author: { pubkey: 'author', kind: 'human', name: 'Before rename' } };
const stamp = currentSurfaceStamp();
stampRoomMessageRows([original], stamp);

class Boundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error: error.message }; }
  componentDidCatch(error) { console.log('[UPDATE-DEPTH-1] ERROR ' + error.message); }
  render() { return this.state.error ? <Text accessibilityLabel="Room error">{this.state.error}</Text> : this.props.children; }
}

function Room() {
  const renders = React.useRef(0);
  const turns = useRoomTurnRecords(scope, roomId);
  const identityVersion = useIdentityRecords();
  // The Room session repeats this identity selection when turn records change.
  const rows = React.useMemo(() => [new IdentitySelection(scope, stamp).message(original)], [turns, identityVersion]);
  const [messages] = useRoomMessageRecords(scope, roomId, [rows]);
  renders.current++;
  React.useEffect(() => {
    console.log(`[UPDATE-DEPTH-1] PAINT renders=${renders.current} author=${messages[0]?.author.name} text=${messages[0]?.text}`);
  });
  return <View style={{ gap: 24 }}>
    <Text>Room · renamed author</Text>
    {messages.map(message => <View key={message.id}>
      <Text>{message.author.name}</Text><Text>{message.text}</Text>
    </View>)}
    <Text>Renders: {renders.current}</Text>
    <Pressable accessibilityLabel="Edit message" onPress={() => writeRoomMessage(scope, roomId,
      { ...messages[0], version: 2, text: 'Edited message' })}><Text>Edit message</Text></Pressable>
  </View>;
}

function App() {
  const [open, setOpen] = React.useState(false);
  return <View style={{ flex: 1, padding: 32, paddingTop: 80, gap: 32, backgroundColor: '#ffffff' }}>
    <Text>UPDATE-DEPTH-1 · Android</Text>
    {open ? <Boundary><Room /></Boundary> : <Pressable accessibilityLabel="Open Room" onPress={() => {
      recordPerson(scope, { ...original.author, name: 'Renamed' }, nextSurfaceStamp());
      setOpen(true);
    }}><Text>Open Room</Text></Pressable>}
  </View>;
}
registerRootComponent(App);
