import 'react-native-get-random-values';
import '../../sources/unistyles';
import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NewRoomDialog } from '../../sources/components/buzz/NewRoomDialog';
import { setAppAppearance } from '../../sources/unistyles';

// Temporary native entry for the documented visual reproduction only.
setAppAppearance('dark');
const noop = () => undefined;
function Capture() {
  const [fonts] = useFonts({
    'SpaceGrotesk-Regular': require('../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const [name, setName] = React.useState('dashboard');
  if (!fonts) return null;
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider>
    <View style={{ flex: 1 }} />
    <NewRoomDialog visible roomName={name} setRoomName={setName}
      inviteOnly={false} setInviteOnly={noop} creatingRoom={false} createRoom={noop}
      onClose={noop} pendingRepo={null} showRepoPicker={false} handleToggleRepoPicker={noop}
      handleSelectNoRepository={noop} handleSelectRepoCandidate={noop}
      repoCandidates={[]} repoInstallations={[]} repoPickerError={null} />
  </SafeAreaProvider></GestureHandlerRootView>;
}
registerRootComponent(Capture);
