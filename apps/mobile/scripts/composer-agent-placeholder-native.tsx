/** Standalone native proof: real composer and native TextInput for each conversation kind. */
import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { beelineThemes } from '../sources/buzz/groknight';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../sources/theme';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';

StyleSheet.configure({ themes: { bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme,
  obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme },
  settings: { initialTheme: 'bone' } });
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const [dark, setDark] = useState(false);
  const theme = dark ? beelineThemes.obsidian : beelineThemes.bone;
  if (!loaded) return null;
  return <View style={{ flex: 1, backgroundColor: theme.bgBase, paddingTop: 100, gap: 36 }}>
    <Pressable accessibilityLabel="Toggle theme" onPress={() => {
      UnistylesRuntime.setTheme(dark ? 'bone' : 'obsidian');
      setDark(!dark);
    }}><Text style={{ color: theme.textPrimary }}>Toggle theme</Text></Pressable>
    {[
      { title: '#general · agent member', hasAgentMembers: true },
      { title: 'Agent DM', hasAgentMembers: true, isDirectMessage: true },
      { title: '#people-only · no agents', hasAgentMembers: false },
      { title: '#corner · agent member', hasAgentMembers: true },
    ].map(({ title, hasAgentMembers, isDirectMessage }) => <View key={title} style={{ paddingHorizontal: 16, gap: 8 }}>
      <Text style={{ color: theme.textPrimary }}>{title}</Text>
      <ConversationComposer value="" height={26} focused={false} disabled={false}
        isDirectMessage={isDirectMessage} hasAgentMembers={hasAgentMembers} speechEnabled={false}
        onBlur={() => {}} onFocus={() => {}} onKeyPress={() => {}}
        onChangeText={() => {}} onSend={() => {}} onContentSizeChange={() => {}} />
    </View>)}
  </View>;
}
registerRootComponent(Proof);
