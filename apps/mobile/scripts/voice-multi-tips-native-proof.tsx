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
const agents = [{ pubkey: 'a'.repeat(64), kind: 'agent', name: 'Ruby' }, { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Goosy' },
  { pubkey: 'c'.repeat(64), kind: 'agent', name: 'Candy' }];
function Proof() {
  const [loaded] = useFonts({ 'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf') });
  const [value, setValue] = useState('');
  const [theme, setTheme] = useState<'bone' | 'obsidian'>('obsidian');
  const [humans, setHumans] = useState(2);
  const [unaddressed, setUnaddressed] = useState(0);
  const voice = { call: { id: 'fixture' }, agents, target: null, speaker: null, level: 0,
    connecting: false, error: null, quotaExhausted: false, firstAudioMs: null, humans, unaddressed,
    join: async () => {}, end: async () => {}, aim() {} } as unknown as VoiceCallState;
  if (!loaded) return null;
  const colors = beelineThemes[theme];
  const buttons: [string, () => void][] = [['One human', () => setHumans(1)], ['Two humans', () => setHumans(2)],
    ['Dropped turn', () => setUnaddressed(n => n + 1)], ['Obsidian', () => { UnistylesRuntime.setTheme('obsidian'); setTheme('obsidian'); }],
    ['Bone', () => { UnistylesRuntime.setTheme('bone'); setTheme('bone'); }]];
  return <View style={{ flex: 1, backgroundColor: colors.bgBase, paddingTop: 80, paddingHorizontal: 16 }}>
    <Text style={{ color: colors.textPrimary }}>Voice tips proof · humans {humans} · unaddressed {unaddressed}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginVertical: 16 }}>
      {buttons.map(([label, onPress]) => <Pressable key={label} accessibilityLabel={label} onPress={onPress}
        style={{ paddingVertical: 8 }}>
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
