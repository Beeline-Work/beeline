/** Isolated Android proof: real hook, RTC transport and warning player. */
import 'react-native-get-random-values';
import '../sources/unistyles';
import React, { useEffect, useState } from 'react';
import { registerRootComponent } from 'expo';
import { Text, View, Button } from 'react-native';
import { useFonts } from 'expo-font';
import { UnistylesRuntime } from 'react-native-unistyles';
import { VoiceBar } from '../sources/components/buzz/VoiceBar';
import { VoiceCallCard } from '../sources/components/buzz/VoiceCallCard';
import { useVoiceCall } from '../sources/buzz/use-voice-call';
import { monolithSession } from '../sources/auth/monolith-session';
import { beelineThemes } from '../sources/buzz/groknight';
const origin = 'http://10.0.2.2:38497';
UnistylesRuntime.setTheme('obsidian');
function Session({ config }: { config: any }) {
  const voice = useVoiceCall(config.roomId, true, config.agents);
  const [light, setLight] = useState(false);
  const colors = beelineThemes[light ? 'bone' : 'obsidian'];
  useEffect(() => {
    void fetch(origin + '/__observe', { method: 'POST', body: JSON.stringify({ joined: !!voice.call,
      warning: voice.budgetWarning, audioReady: !!voice.warningAudio, error: voice.error }) });
  }, [voice.call, voice.budgetWarning, voice.warningAudio, voice.error]);
  return <View style={{ flex: 1, padding: 16, paddingTop: 64, backgroundColor: colors.bgBase }}>
    <Text style={{ color: colors.textPrimary }}>Daily call limit · Android proof</Text>
    <Button title="Theme" onPress={() => { UnistylesRuntime.setTheme(light ? 'obsidian' : 'bone'); setLight(!light); }} />
    <VoiceCallCard call={config.call} joined={!!voice.call} connecting={voice.connecting}
      error={voice.error} onJoin={() => void voice.join()} agents={config.agents} />
    <View style={{ flex: 1 }} />
    {(voice.call || voice.connecting) && <VoiceBar voice={voice} />}
    {voice.error && <Text style={{ color: colors.textPrimary }}>{voice.error}</Text>}
  </View>;
}
function Proof() {
  const [config, setConfig] = useState<any>();
  const [error, setError] = useState('');
  const [fonts] = useFonts({ 'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf') });
  useEffect(() => { void fetch(origin + '/__config').then(r => r.json()).then(value => {
    // Only this fixture process uses the disposable server's token. No saved account.
    monolithSession.authorization = async () => value.token;
    setConfig(value);
  }).catch(e => setError(String(e))); }, []);
  return config && fonts ? <Session config={config} /> : <Text>{error || 'Connecting to isolated proof'}</Text>;
}
registerRootComponent(Proof);
