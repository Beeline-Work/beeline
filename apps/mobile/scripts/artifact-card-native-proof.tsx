// Native proof entry for the restored artifact card footer. Renders the real
// ArtifactCard for non-previewable file cards (video/mp4, application/zip) and
// for the previewable artifacts that share ArtifactCardShell (image, PDF,
// HTML) so the v0.1.106 footer is captured for every format and theme.
import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import {
  boneTheme,
  obsidianTheme,
  boneSmallTheme,
  boneLargeTheme,
  obsidianSmallTheme,
  obsidianLargeTheme,
} from '../sources/theme';

// Switch this to 'obsidian' for the dark-theme capture.
const PROOF_THEME = 'bone' as const;

StyleSheet.configure({
  themes: {
    bone: boneTheme,
    obsidian: obsidianTheme,
    boneSmall: boneSmallTheme,
    boneLarge: boneLargeTheme,
    obsidianSmall: obsidianSmallTheme,
    obsidianLarge: obsidianLargeTheme,
  },
  settings: { initialTheme: PROOF_THEME },
});

import { ArtifactCard } from '../sources/components/buzz/ArtifactCard';
import { Button } from '../sources/components/buzz/Button';
import type { AttachmentReference } from '@beeline/buzz-client';

const videoFile = {
  url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556666',
  name: 'corner-demo.mp4',
  title: 'Corner demo',
  mimeType: 'video/mp4',
  size: 10_276_045,
  kind: 'artifact',
  author: 'ruby',
} as unknown as AttachmentReference;

const zipFile = {
  url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556667',
  name: 'bundle.zip',
  title: 'Bundle',
  mimeType: 'application/zip',
  size: 120_000,
  kind: 'artifact',
  author: 'ruby',
} as unknown as AttachmentReference;

const imageFile = {
  url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556668',
  name: 'photo.png',
  title: 'Photo',
  mimeType: 'image/png',
  size: 204_800,
  kind: 'artifact',
  author: 'ruby',
} as unknown as AttachmentReference;

const pdfFile = {
  url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556669',
  name: 'brief.pdf',
  title: 'Brief',
  mimeType: 'application/pdf',
  size: 340_000,
  kind: 'artifact',
  author: 'ruby',
} as unknown as AttachmentReference;

const htmlFile = {
  url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556670',
  name: 'mock.html',
  title: 'Mock',
  mimeType: 'text/html',
  size: 42_000,
  kind: 'artifact',
  author: 'ruby',
} as unknown as AttachmentReference;

const sourceFiles: { label: string; attachment: AttachmentReference }[] = [
  { label: 'File card · video/mp4 (browser link only)', attachment: videoFile },
  { label: 'File card · application/zip (browser link only)', attachment: zipFile },
  { label: 'Image card · image/png (browser link + Open →)', attachment: imageFile },
  { label: 'PDF card · application/pdf (browser link + Open →)', attachment: pdfFile },
  { label: 'HTML card · text/html (browser link + Open →)', attachment: htmlFile },
];

function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const { theme } = useUnistyles();
  if (!loaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ScrollView
        style={{ backgroundColor: theme.buzz.bgBase }}
        contentContainerStyle={{ padding: 16, paddingTop: 48, gap: 16 }}
      >
        <View style={{ flexDirection: 'row', gap: 16 }}>
          {(['bone', 'obsidian'] as const).map((name) => (
            <Button
              key={name}
              label={name}
              variant="secondary"
              onPress={() => UnistylesRuntime.setTheme(name)}
            />
          ))}
        </View>
        {sourceFiles.map(({ label, attachment }) => (
          <React.Fragment key={label}>
            <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.textPrimary }}>
              {label}
            </Text>
            <ArtifactCard attachment={attachment} />
          </React.Fragment>
        ))}
      </ScrollView>
    </GestureHandlerRootView>
  );
}

registerRootComponent(Proof);