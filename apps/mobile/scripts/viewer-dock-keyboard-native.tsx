import '../sources/unistyles';
import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { View, Text, Pressable } from 'react-native';
import { UnistylesRuntime } from 'react-native-unistyles';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HullModal } from '../sources/components/buzz/HullDialog';
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
  const [warm, setWarm] = React.useState(false);
  const [kind, setKind] = React.useState<'artifact' | 'computer'>('artifact');
  const [WebView, setWebView] = React.useState<React.ComponentType<any> | null>(null);
  React.useEffect(() => { void import('react-native-webview').then(module => setWebView(() => module.WebView)); }, []);
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  const content = <View style={{ flex: 1, backgroundColor: '#14091A', paddingTop: 60 }}>
    <Text style={{ color: '#f0f0f3', padding: 16 }}>Call states and endings (1–9)</Text>
    <Pressable accessibilityLabel="Switch viewer" onPress={() => setKind(current => current === 'artifact' ? 'computer' : 'artifact')}>
      <Text style={{ color: '#c9c9d1', padding: 16 }}>{kind} viewer · Switch viewer</Text>
    </Pressable>
    {WebView ? <WebView style={{ flex: 1 }} source={{ html: '<html><body><h1>HTML file</h1><p>The file stays visible above the message box.</p></body></html>' }} javaScriptEnabled={false} /> : null}
    <Pressable accessibilityLabel="Warm viewer" onPress={() => { setKind('computer'); setWarm(true); }}><Text style={{ color: '#f0f0f3', padding: 16 }}>Warm computer viewer</Text></Pressable>
    <Pressable accessibilityLabel="Bone" onPress={() => UnistylesRuntime.setTheme('bone')}>
      <Text style={{color: '#f0f0f3', padding: 16}}>Bone theme</Text>
    </Pressable>
    <ViewerConversationDock keyboardAvoidedByParent={!warm} key={`${kind}:${warm}`} kind={kind} title="Call states and endings (1–9)" roomId="proof" agentHandle="ruby" captureScreen={async () => "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQTkAAAAASUVORK5CYII="} />
  </View>;
  return <SafeAreaProvider><KeyboardProvider preload={false}>{warm ? content : <HullModal visible placement="fill" dismissOnBackdrop={false} onRequestClose={() => {}}>{content}</HullModal>}</KeyboardProvider></SafeAreaProvider>;
}
registerRootComponent(Proof);
