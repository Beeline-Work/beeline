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
function Proof() {
  const [loaded] = useFonts({ 'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf') });
  const [value, setValue] = useState('');
  const [theme, setTheme] = useState<'bone' | 'obsidian'>('obsidian');
  const [active, setActive] = useState(false);
  const [joins, setJoins] = useState(0);
  const voice = { call: active ? { id: 'fixture' } : null, agents: [], target: null, speaker: null, level: 0,
    connecting: false, error: null, endingWarning: undefined, quotaExhausted: false, budgetWarning: null, warningAudio: null, clearWarningAudio() {}, muted: false, toggleMute: async () => {}, firstAudioMs: null, humans: 1, unaddressed: 0,
    join: async () => { setJoins(n => n + 1); setActive(true); }, end: async () => setActive(false), aim() {} } as VoiceCallState;
  if (!loaded) return null;
  const colors = beelineThemes[theme];
  return <View style={{ flex: 1, backgroundColor: colors.bgBase, paddingTop: 80, paddingHorizontal: 16 }}>
    <Text style={{ color: colors.textPrimary }}>Conversation entry proof · joins {joins}</Text>
    <View style={{ flexDirection: 'row', gap: 16, marginVertical: 16 }}>
      {['Obsidian', 'Bone', 'Empty', 'Typed'].map(label => <Pressable key={label} accessibilityLabel={label}
        onPress={() => { if (label === 'Empty') setValue(''); else if (label === 'Typed') setValue('Ruby, what merged today?');
          else { const next = label.toLowerCase() as 'bone' | 'obsidian'; UnistylesRuntime.setTheme(next); setTheme(next); } }}>
        <Text style={{ color: colors.textPrimary }}>{label}</Text>
      </Pressable>)}
    </View>
    <View style={{ flex: 1 }} />
    <View style={{ marginBottom: 80 }}>
      <ConversationComposer voice={voice} value={value} height={26} focused={false} disabled={false}
        onAttach={() => {}} onBlur={() => {}} onFocus={() => {}} onKeyPress={() => {}}
        onChangeText={setValue} onSend={() => setValue('')} onContentSizeChange={() => {}} />
    </View>
  </View>;
}
registerRootComponent(Proof);
