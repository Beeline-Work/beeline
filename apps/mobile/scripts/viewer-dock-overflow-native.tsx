import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { obsidianTheme, obsidianSmallTheme, obsidianLargeTheme, boneTheme, boneSmallTheme, boneLargeTheme } from '../sources/theme';
import { ViewerConversationDock } from '../sources/components/buzz/ViewerConversationDock';
import { publishViewerConversation } from '../sources/buzz/viewer-conversation';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
StyleSheet.configure({ themes: { obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme, bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme }, settings: { initialTheme: 'obsidian' } });
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
  return <SafeAreaProvider><View style={{ flex: 1, backgroundColor: '#14091A', paddingTop: 60 }}>
    <Text style={{ color: '#f0f0f3', padding: 16 }}>Call states and endings (1–9)</Text>
    <Text style={{ color: '#c9c9d1', padding: 16 }}>Artifact fixture · viewer-dock-overflow</Text>
    <ViewerConversationDock kind="artifact" title="Call states and endings (1–9)" roomId="proof" agentHandle="ruby" />
  </View></SafeAreaProvider>;
}
registerRootComponent(Proof);
