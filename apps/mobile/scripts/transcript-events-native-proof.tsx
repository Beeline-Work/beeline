import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  boneTheme,
  boneSmallTheme,
  boneLargeTheme,
  obsidianTheme,
  obsidianSmallTheme,
  obsidianLargeTheme,
} from '../sources/theme';
import { CornerOpenedMarker } from '../sources/components/buzz/CornerOpenedMarker';
import { NotificationLifecycleCard } from '../sources/components/buzz/PrLifecycleCard';
import { DaemonFactCard, GitHubEventCard } from '../sources/components/buzz/LifecycleCard';
import { foldPrLifecycleRuns, lifecycleCornerTitle } from '../sources/buzz/pr-lifecycle';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
import snapshot from './transcript-event-room-snapshot.json';
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
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const { theme } = useUnistyles();
  const [run, setRun] = useState(0);
  const [before, setBefore] = useState(false);
  const [destination, setDestination] = useState('');
  const messages = snapshot.runs[run].map((row) => ({
    id: row.id,
    text: row.text,
    timestamp: Number(row.timestamp),
    isUser: false,
    ...(row.card_type === 'daemon-fact' ? { daemonFact: row.card } : { githubEvent: row.card }),
  })) as ChatDisplayMessage[];
  if (!loaded) return null;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.buzz.bgBase }}
      contentContainerStyle={{ padding: 16, paddingTop: 48 }}
    >
      <Text style={{ ...theme.buzz.type.hero, color: theme.buzz.textPrimary }}>#beeline</Text>
      <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet }}>
        Production Room snapshot · 21 Oct
      </Text>
      <View style={{ flexDirection: 'row', gap: 16 }}>
        <Pressable
          accessibilityLabel="Switch event run"
          onPress={() => {
            setRun(1 - run);
            setDestination('');
          }}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.accent }}>
            {run ? 'Issue + PR' : 'Corner + PR'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Toggle original cards"
          onPress={() => setBefore(!before)}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.accent }}>
            {before ? 'Show event rows' : 'Show original cards'}
          </Text>
        </Pressable>
      </View>
      <View key={`${run}-${before}`}>
        {(before ? messages : foldPrLifecycleRuns(messages)).map((message) =>
          before ? (
            message.githubEvent ? (
              <GitHubEventCard key={message.id} message={message} onOpenUrl={setDestination} />
            ) : (
              <DaemonFactCard
                key={message.id}
                message={message}
                onOpenCorner={setDestination}
                onOpenUrl={setDestination}
              />
            )
          ) : message.notificationLifecycleRun ? (
            <NotificationLifecycleCard
              key={message.id}
              message={message}
              onOpenCorner={setDestination}
              onOpenUrl={setDestination}
            />
          ) : (
            <CornerOpenedMarker
              key={message.id}
              title={lifecycleCornerTitle(message.daemonFact!)}
              onOpen={() => setDestination(message.daemonFact!.cornerId)}
            />
          ),
        )}
      </View>
      <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet }}>
        Chat ends this run.
      </Text>
      <Text
        accessibilityLabel={destination}
        style={{ ...theme.buzz.type.meta, color: theme.buzz.textPrimary }}
      >
        {destination}
      </Text>
    </ScrollView>
  );
}
registerRootComponent(Proof);
