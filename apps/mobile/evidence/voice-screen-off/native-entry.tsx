/** Isolated Android proof surface using the production hook and native transport. */
import 'react-native-get-random-values';
import React from 'react';
import { Button, SafeAreaView, Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import { monolithSession } from '../../sources/auth/monolith-session';
import { useVoiceCall } from '../../sources/buzz/use-voice-call';

const ROOM = '22222222-2222-4222-8222-222222222222';
function VoiceProof() {
  const [ready, setReady] = React.useState(false);
  const [failure, setFailure] = React.useState('');
  const voice = useVoiceCall(ROOM, ready);
  React.useEffect(() => {
    void monolithSession.exchangeGitHubTicket('isolated-voice-proof').then(() => setReady(true)).catch(error => setFailure(String(error)));
  }, []);
  return <SafeAreaView style={{flex:1,padding:30,backgroundColor:'#fff'}}>
    <Text style={{fontSize:24}}>Isolated Conversation proof</Text>
    <Text testID="status">{failure || voice.error || (voice.connecting ? 'Connecting' : voice.call ? 'Conversation active' : ready ? 'Ready' : 'Signing in')}</Text>
    <Text>Speaker: {voice.speaker ?? 'none'}</Text>
    <View style={{marginVertical:30}}><Button title="Start Conversation" onPress={() => { void voice.join(); }} /></View>
    <Button title="Stop Conversation" onPress={() => { void voice.end(); }} />
  </SafeAreaView>;
}
registerRootComponent(VoiceProof);
