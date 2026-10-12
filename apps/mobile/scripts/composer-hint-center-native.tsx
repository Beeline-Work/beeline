/** Standalone native proof: real composer, fonts, TextInput and font scaling. */
import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Keyboard, KeyboardAvoidingView, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { beelineThemes } from '../sources/buzz/groknight';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../sources/theme';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';

StyleSheet.configure({ themes: { bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme,
  obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme },
  settings: { initialTheme: 'bone' } });
const handles = new Set(['ruby']);
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const [value, setValue] = useState('');
  const [height, setHeight] = useState(26);
  const [viewer, setViewer] = useState(false);
  if (!loaded) return null;
  const choose = (next: string) => { setValue(next); setHeight(26); };
  return <KeyboardAvoidingView behavior="height" style={{ flex: 1, backgroundColor: beelineThemes.bone.bgBase, paddingTop: 80, paddingBottom: 64 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16 }}>
      {[
        ['Empty', () => choose('')], ['Typed', () => choose('Message')],
        ['Tagged', () => choose('@ruby Message')], ['Tags only', () => choose('@ruby ')],
        ['Multiline', () => choose('@ruby Message\nAgjypq café\nMessage')],
        ['Viewer', () => setViewer(true)], ['Room', () => setViewer(false)],
        ['Hide keyboard', () => Keyboard.dismiss()],
      ].map(([label, action]) => <Pressable key={label as string} accessibilityLabel={label as string}
        onPress={action as () => void} style={{ padding: 12, borderWidth: 1 }}>
        <Text>{label as string}</Text>
      </Pressable>)}
    </View>
    <View style={{ flex: 1 }} />
    <View style={{ marginHorizontal: 16, ...(viewer ? { borderWidth: 1, borderColor: beelineThemes.bone.accent } : {}) }}>
      <ConversationComposer value={value} height={height} maxHeight={120} focused disabled={false}
        viewerPill={viewer} speechEnabled={false} tagHandles={handles}
        onAttach={() => {}} onBlur={() => {}} onFocus={() => {}} onKeyPress={() => {}}
        onChangeText={setValue} onSend={() => {}}
        onContentSizeChange={event => setHeight(viewer && !value.trim() ? 26
          : Math.min(120, Math.max(26, Math.ceil(event.nativeEvent.contentSize.height))))}
      />
    </View>
  </KeyboardAvoidingView>;
}
registerRootComponent(Proof);
