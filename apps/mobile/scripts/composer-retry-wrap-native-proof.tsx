import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../sources/theme';
import { beelineThemes } from '../sources/buzz/groknight';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import type { VoiceCallState } from '../sources/buzz/use-voice-call';

StyleSheet.configure({
  themes: {
    bone: boneTheme,
    boneSmall: boneSmallTheme,
    boneLarge: boneLargeTheme,
    obsidian: obsidianTheme,
    obsidianSmall: obsidianSmallTheme,
    obsidianLarge: obsidianLargeTheme,
  },
  settings: { initialTheme: 'bone' },
});

const voice = {
  call: null, agents: [], target: null, speaker: null, level: 0, connecting: false, error: null,
  quotaExhausted: false, firstAudioMs: null, join: async () => {}, end: async () => {}, aim() {},
} as unknown as VoiceCallState;

function Composer() {
  const [value, setValue] = useState('@ruby set it');
  const [height, setHeight] = useState(26);
  return (
    <ConversationComposer
      voice={voice}
      value={value}
      height={height}
      focused={false}
      disabled={false}
      testIDPrefix="retry"
      reply={{
        handle: 'ruby',
        preview: 'The signing key matches. But the release window closed before the build landed.',
      }}
      attachments={[{
        uri: 'file:///28089.jpg',
        name: '28089.jpg',
        mimeType: 'image/jpeg',
        sizeLabel: '341 KB',
        uploadState: 'failed',
      }]}
      onAttach={() => {}}
      onBlur={() => {}}
      onCancelReply={() => {}}
      onChangeText={setValue}
      onContentSizeChange={(event) => setHeight(Math.max(26, Math.ceil(event.nativeEvent.contentSize.height)))}
      onFocus={() => {}}
      onKeyPress={() => {}}
      onRemoveAttachment={() => {}}
      onRetryAttachment={() => {}}
      onSend={() => {}}
    />
  );
}

function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const [theme, setTheme] = useState<'bone' | 'obsidian'>('bone');
  if (!loaded) return null;
  const colors = beelineThemes[theme];
  return (
    <View style={{ flex: 1, backgroundColor: colors.bgBase, paddingTop: 48, paddingHorizontal: 16 }}>
      <View style={{ flexDirection: 'row', gap: 24, marginBottom: 24 }}>
        {(['Bone', 'Obsidian'] as const).map((label) => (
          <Pressable
            key={label}
            accessibilityLabel={label}
            onPress={() => {
              const next = label.toLowerCase() as 'bone' | 'obsidian';
              UnistylesRuntime.setTheme(next);
              setTheme(next);
            }}
          >
            <Text style={{ color: colors.textPrimary }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Composer />
    </View>
  );
}

registerRootComponent(Proof);
