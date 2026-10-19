import '../sources/unistyles';
import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { View, Text, Pressable } from 'react-native';
import { UnistylesRuntime } from 'react-native-unistyles';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ViewerConversationDock } from '../sources/components/buzz/ViewerConversationDock';
import { publishViewerConversation } from '../sources/buzz/viewer-conversation';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
UnistylesRuntime.setTheme('obsidian');
const text = '**FIRST LINE**\n\n' + Array.from({ length: 45 }, (_, i) => `- **State ${i+1}**: A long reply about call states and endings remains readable while the artifact stays visible.`).join('\n') + '\n\n**NEWEST LINE**';
const send = async () => {
  setTimeout(() => publishViewerConversation({ roomId: 'proof', messages: [{ id: 'reply', text, presentation: 'message', author: { kind: 'agent', handle: 'ruby', name: 'Ruby' } } as RoomViewMessage], send }), 100);
  return true;
};
publishViewerConversation({ roomId: 'proof', messages: [], send });
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return <SafeAreaProvider><KeyboardProvider preload={false}><View style={{ flex: 1, backgroundColor: '#14091A', paddingTop: 60 }}>
    <Text style={{ color: '#f0f0f3', padding: 16 }}>Call states and endings (1–9)</Text>
    <Text style={{ color: '#c9c9d1', padding: 16 }}>Shared browser fixture · R1 / R2</Text>
    <Pressable accessibilityLabel="Bone" onPress={() => UnistylesRuntime.setTheme('bone')}>
      <Text style={{color: '#f0f0f3', padding: 16}}>Bone theme</Text>
    </Pressable>
    <ViewerConversationDock kind="computer" title="Call states and endings (1–9)" roomId="proof" agentHandle="ruby" captureScreen={async () => "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQTkAAAAASUVORK5CYII="} />
  </View></KeyboardProvider></SafeAreaProvider>;
}
registerRootComponent(Proof);
