import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../sources/theme';
import { beelineThemes } from '../sources/buzz/groknight';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import type { VoiceCallState } from '../sources/buzz/use-voice-call';
StyleSheet.configure({ themes: { bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme, obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme }, settings: { initialTheme: 'obsidian' } });
const voice = { call: null, agents: [], target: null, speaker: null, level: 0, connecting: false, error: null,
  quotaExhausted: false, firstAudioMs: null, join: async () => {}, end: async () => {}, aim() {} } as unknown as VoiceCallState;
const tags = new Set(['ruby']);
// The three locked v4 states, each a production composer; the third dictates for real.
function Composer({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [height, setHeight] = useState(26);
  return <View style={{ marginBottom: 16 }}>
    <ConversationComposer voice={voice} value={value} height={height} focused={false} disabled={false}
      tagHandles={tags} onAttach={() => {}} onBlur={() => {}} onFocus={() => {}} onKeyPress={() => {}}
      onChangeText={setValue} onSend={() => setValue('')}
      onContentSizeChange={event => setHeight(Math.max(26, Math.ceil(event.nativeEvent.contentSize.height)))} />
  </View>;
}
function Proof() {
  const [loaded] = useFonts({ 'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf') });
  const [theme, setTheme] = useState<'bone' | 'obsidian'>('obsidian');
  if (!loaded) return null;
  const colors = beelineThemes[theme];
  return <View key={theme} style={{ flex: 1, backgroundColor: colors.bgBase, paddingTop: 80, paddingHorizontal: 16 }}>
    <View style={{ flexDirection: 'row', gap: 24, marginBottom: 24 }}>
      {(['Obsidian', 'Bone'] as const).map(label => <Pressable key={label} accessibilityLabel={label}
        onPress={() => { const next = label.toLowerCase() as 'bone' | 'obsidian'; UnistylesRuntime.setTheme(next); setTheme(next); }}>
        <Text style={{ color: colors.textPrimary }}>{label}</Text>
      </Pressable>)}
    </View>
    {[['Empty', ''], ['Has text', '@ruby check the multiway corner'], ['Dictating', '@ruby ']].map(([label, initial]) =>
      <View key={label}>
        <Text style={{ color: colors.textMuted, marginBottom: 6 }}>{label}</Text>
        <Composer initial={initial} />
      </View>)}
  </View>;
}
registerRootComponent(Proof);
