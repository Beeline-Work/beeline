/** R1 stand-in: production sheet and operation transport, disposable offline endpoint. */
import 'react-native-get-random-values';
import '../sources/unistyles';
import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useFonts } from 'expo-font';
import { CornerActionsSheet } from '../sources/components/buzz/CornerActionsSheet';
import { Button } from '../sources/components/buzz/Button';
import { monolithPhoneOperation } from '../sources/sync/transport/monolith-operation';
import { monolithSession } from '../sources/auth/monolith-session';
// Models a native offline transport that never settles and ignores abort.
monolithSession.fetch = () => new Promise(() => {});
function Proof() {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState('Reproduction R1: open a corner, then Close corner');
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return <GestureHandlerRootView style={{flex:1}}><SafeAreaProvider><KeyboardProvider>
    <View style={{flex:1,padding:32,paddingTop:80,backgroundColor:'#ffffff'}}>
      <Text style={{color:'#111111'}}>{status}</Text>
      <Button label="Open corner actions" onPress={()=>{setStatus('Corner actions open');setVisible(true);}} />
      <CornerActionsSheet visible={visible} title="R1 disposable corner" connected locked={false}
        onClose={()=>{setVisible(false);setStatus('PASS: Back left the waiting sheet immediately');}}
        closeCorner={async()=>{
          const started=Date.now();
          try {await monolithPhoneOperation('requestCornerClose',{roomId:'r1-disposable'});}
          catch(error){setStatus(`Timeout after ${((Date.now()-started)/1000).toFixed(1)}s: ${(error as Error).message}`);throw error;}
        }}
        setLocked={async()=>{}} onClosed={()=>setStatus('Unexpected success')}
        onSaved={()=>{}} onError={()=>setVisible(false)} />
    </View>
  </KeyboardProvider></SafeAreaProvider></GestureHandlerRootView>;
}
registerRootComponent(Proof);
