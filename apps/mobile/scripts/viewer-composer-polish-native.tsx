import '../sources/unistyles';
import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { View, Text, Pressable } from 'react-native';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ViewerConversationDock } from '../sources/components/buzz/ViewerConversationDock';
import { TranscriptReference } from '../sources/components/buzz/TranscriptReference';
import { publishViewerConversation } from '../sources/buzz/viewer-conversation';
UnistylesRuntime.setTheme('bone');
publishViewerConversation({ roomId: 'proof', messages: [], send: async () => true });
function Proof() {
  const { theme } = useUnistyles();
  const [kind, setKind] = React.useState<'artifact' | 'computer'>('artifact');
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return <SafeAreaProvider><KeyboardProvider preload={false}>
    <View style={{ flex: 1, backgroundColor: theme.buzz.bgBase, paddingTop: 60, paddingHorizontal: 16 }}>
      <Text style={{ ...theme.buzz.type.hero, color: theme.buzz.textPrimary }}>Tap selection preview</Text>
      <Text style={{ ...theme.buzz.type.body, color: theme.buzz.textSecondary }}>Local viewer fixture · {kind}</Text>
      <Pressable accessibilityLabel="Switch theme" onPress={() => UnistylesRuntime.setTheme(UnistylesRuntime.themeName === 'bone' ? 'obsidian' : 'bone')}>
        <Text style={{ ...theme.buzz.type.body, color: theme.buzz.accent, paddingVertical: 16 }}>Switch theme</Text>
      </Pressable>
      <Pressable accessibilityLabel="Switch viewer" onPress={() => setKind(kind === 'artifact' ? 'computer' : 'artifact')}>
        <Text style={{ ...theme.buzz.type.body, color: theme.buzz.accent, paddingVertical: 16 }}>Switch viewer</Text>
      </Pressable>
      <TranscriptReference viewer>Viewing Tap selection preview</TranscriptReference>
      <Text style={{ ...theme.buzz.type.body, color: theme.buzz.textPrimary }}>Make the handles larger</Text>
      <ViewerConversationDock kind={kind} title="Tap selection preview" roomId="proof" agentHandle="jellybean" captureScreen={async () => 'local-fixture'} />
    </View>
  </KeyboardProvider></SafeAreaProvider>;
}
registerRootComponent(Proof);
