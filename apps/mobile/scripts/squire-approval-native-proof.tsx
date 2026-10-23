/** Disposable Android proof using the real local approval service and card. */
import 'react-native-get-random-values';
import React from 'react';
import { registerRootComponent } from 'expo';
import { LogBox, View, Text } from 'react-native';
import { useFonts } from 'expo-font';
require('../sources/unistyles');
import { SquireApprovalCard } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import { displayRoomMessage } from '../sources/buzz/room-view-presentation';
import { Button } from '../sources/components/buzz/Button';
LogBox.ignoreAllLogs();
const origin = 'http://127.0.0.1:18740';
function Proof() {
  const [state, setState] = React.useState<any>();
  const [error, setError] = React.useState('');
  const [fonts] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const read = async (decide = false) => {
    try {
      const response = await fetch(origin + (decide ? '/decide' : '/'), {
        method: decide ? 'POST' : 'GET',
      });
      if (!response.ok) throw new Error(await response.text());
      setState(await response.json());
    } catch (error) {
      setError(String(error));
    }
  };
  React.useEffect(() => {
    void read();
  }, []);
  return fonts ? (
    <View
      style={{
        flex: 1,
        backgroundColor: '#14091A',
        paddingTop: 80,
        paddingHorizontal: 16,
        gap: 24,
      }}
    >
      <Text style={{ color: '#f0f0f3', fontFamily: 'SpaceGrotesk-Medium', fontSize: 22 }}>
        System
      </Text>
      {state?.approval && (
        <SquireApprovalCard
          message={displayRoomMessage(state.approval, 'a'.repeat(64))}
          onOpenSource={() => {}}
        />
      )}
      {state && (
        <>
          <Button
            label={state.decided ? 'Approval relayed' : 'Approve test request'}
            disabled={state.decided}
            onPress={() => {
              void read(true);
            }}
          />
          {state.rooms.map((room: any) => (
            <View key={room.name} style={{ gap: 8 }}>
              <Text style={{ color: '#f0f0f3', fontSize: 18 }}>{room.name}</Text>
              {room.messages.map((text: string, index: number) => (
                <Text key={index} style={{ color: '#c9c9d1', fontSize: 16 }}>
                  {text}
                </Text>
              ))}
              {state.decided && (
                <Text style={{ color: '#c9c9d1', fontSize: 16 }}>
                  Decision hidden · same turn resumed
                </Text>
              )}
            </View>
          ))}
          <Text style={{ color: '#c9c9d1', fontSize: 16 }}>
            Resume commands: {state.commands.length}
          </Text>
        </>
      )}
      {!!error && <Text style={{ color: '#f0f0f3' }}>{error}</Text>}
    </View>
  ) : null;
}
registerRootComponent(Proof);
