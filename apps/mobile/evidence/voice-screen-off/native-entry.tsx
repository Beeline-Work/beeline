/** Isolated Android proof surface using the production hook and native transport. */
import 'react-native-get-random-values';
import React from 'react';
import { Button, SafeAreaView, Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import { monolithSession } from '../../sources/auth/monolith-session';
import { useVoiceCall } from '../../sources/buzz/use-voice-call';

const request = monolithSession.fetch.bind(monolithSession);
monolithSession.fetch = async (...args: Parameters<typeof request>) => {
  const action = args[0].split('/').at(-1);
  console.log('[VOICE-PROOF]', Date.now(), action, 'before');
  const response = await request(...args);
  console.log('[VOICE-PROOF]', Date.now(), action, 'response', response.status);
  return response;
};

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
    <Button title="Block JS for native Stop proof" onPress={() => {
      console.log('[VOICE-PROOF] JS blocked', Date.now());
      const until = Date.now() + 30_000;
      while (Date.now() < until) { /* Deliberate isolated proof: no JS continuation can stop the server. */ }
      console.log('[VOICE-PROOF] JS released', Date.now());
    }} />
    <Button title="Stop Conversation" onPress={() => { void voice.end(); }} />
  </SafeAreaView>;
}
registerRootComponent(VoiceProof);
