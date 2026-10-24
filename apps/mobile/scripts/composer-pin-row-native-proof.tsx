import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../sources/theme';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import type { VoiceCallState } from '../sources/buzz/use-voice-call';
StyleSheet.configure({ themes: { bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme, obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme }, settings: { initialTheme: 'obsidian' } });
function Proof() {
  const [loaded] = useFonts({ 'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'), 'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf') });
  const [value, setValue] = useState('');
  const { theme } = useUnistyles();
  const [active, setActive] = useState(true);
  const [long, setLong] = useState(false);
  const [target, setTarget] = useState<string | null>('sol');
  const [joins, setJoins] = useState(0);
  const voice = { call: active ? { id: 'fixture' } : null, agents: [{ pubkey: 'sol', kind: 'agent', name: long ? 'Sol with an exceptionally long agent display name' : 'Sol' }, { pubkey: 'jellybean', kind: 'agent', name: 'Jellybean' }, { pubkey: 'ruby', kind: 'agent', name: 'Ruby' }], target, speaker: null, level: 0,
    connecting: false, error: null, endingWarning: undefined, quotaExhausted: false, budgetWarning: null, warningAudio: null, clearWarningAudio() {}, muted: false, toggleMute: async () => {}, firstAudioMs: null, humans: 1, unaddressed: 0,
    join: async () => { setJoins(n => n + 1); setActive(true); }, end: async () => setActive(false), aim(key) { setTarget(current => current === key ? null : key); } } as VoiceCallState;
  if (!loaded) return null;
  const colors = theme.buzz;
  return <View style={{ flex: 1, backgroundColor: colors.bgBase, paddingTop: 80, paddingHorizontal: 16 }}>
    <Text style={{ color: colors.textPrimary }}>Pinned call composer · PIN-ROW-1</Text>
    <View style={{ flexDirection: 'row', gap: 16, marginVertical: 16 }}>
      {['Obsidian', 'Bone', 'Short', 'Long'].map(label => <Pressable key={label} accessibilityLabel={label}
        onPress={() => { if (label === 'Short') { setLong(false); setTarget('sol'); } else if (label === 'Long') { setLong(true); setTarget('sol'); }
          else { const next = label.toLowerCase() as 'bone' | 'obsidian'; UnistylesRuntime.setTheme(next); } }}>
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
