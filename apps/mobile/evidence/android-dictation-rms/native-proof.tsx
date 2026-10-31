// Standalone emulator proof entry. Not imported by the shipped app.
// Only capture transport is replaced: a WAV file feeds the real Google recognizer.
import 'react-native-get-random-values';
import '@/polyfills/arrayFindLast';
import '@/unistyles';
import * as SplashScreen from 'expo-splash-screen';
import React, { useState, useEffect } from 'react';
import { registerRootComponent } from 'expo';
import { View, Text } from 'react-native';
import { UnistylesRuntime } from 'react-native-unistyles';
import { ConversationComposer } from '@/components/buzz/ConversationComposer';
import { getRecognitionModule } from '@/buzz/speech-recognition-adapter';
UnistylesRuntime.setTheme('bone');
const mod = getRecognitionModule();
if (mod) {
 const nativeStart = mod.start;
 mod.supportsRecording = () => false;
 mod.getSpeechRecognitionServices = () => ['com.google.android.tts'];
 mod.getSupportedLocales = async () => ({ locales: ['en-US'], installedLocales: ['en-US'] });
 mod.start = options => nativeStart({ ...options, lang: 'en-US', requiresOnDeviceRecognition: false,
  androidRecognitionServicePackage: 'com.google.android.tts', recordingOptions: { persist: false },
  audioSource: { uri: 'file:///data/local/tmp/speech.wav', sampleRate: 16000,
   audioChannels: 1, audioEncoding: 2, chunkDelayMillis: 128 } });
 mod.addListener?.('volumechange', event => console.log('R1_EXPO_VOLUME', event.value));
}
function Proof() {
 const [value, setValue] = useState('@ruby ');
 useEffect(() => { SplashScreen.hideAsync(); }, []);
 return <View style={{ flex: 1, backgroundColor: '#F3EEE4', paddingTop: 64, paddingHorizontal: 16 }}>
  <Text style={{ color: '#171310', fontSize: 22 }}>R1 Android dictation</Text>
  <Text style={{ color: '#4A4038', marginTop: 12 }}>Google recognizer · recorded normal speech</Text>
  <Text style={{ color: '#4A4038', marginTop: 12 }}>Tap the mic to feed the measured PCM clip.</Text>
  <View style={{ flex: 1 }} />
  <View style={{ marginBottom: 48 }}><ConversationComposer value={value} onChangeText={setValue}
   height={26} focused={false} disabled={false} onAttach={() => {}}
   onBlur={() => {}} onContentSizeChange={() => {}} onFocus={() => {}}
   onKeyPress={() => {}} onSend={() => {}} tagHandles={new Set(['ruby'])} /></View>
 </View>;
}
registerRootComponent(Proof);
