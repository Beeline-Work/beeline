import callsites from './corner-callsite-proof-snapshot.json';
import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import {
  boneTheme,
  obsidianTheme,
  boneSmallTheme,
  boneLargeTheme,
  obsidianSmallTheme,
  obsidianLargeTheme,
} from '../sources/theme';
import { NotificationLifecycleCard } from '../sources/components/buzz/PrLifecycleCard';
import { CornerOpenedMarker } from '../sources/components/buzz/CornerOpenedMarker';
import { anchorCornerMarkers } from '../sources/buzz/corner-markers';
import { foldPrLifecycleRuns } from '../sources/buzz/pr-lifecycle';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
StyleSheet.configure({
  themes: {
    bone: boneTheme,
    obsidian: obsidianTheme,
    boneSmall: boneSmallTheme,
    boneLarge: boneLargeTheme,
    obsidianSmall: obsidianSmallTheme,
    obsidianLarge: obsidianLargeTheme,
  },
  settings: { initialTheme: 'bone' },
});
const base = { text: '', timestamp: 1, isUser: false };
const pr = (id: string, number: number, title: string): ChatDisplayMessage => ({
  ...base,
  id,
  daemonFact: {
    type: 'corner-complete',
    outcome: 'landed',
    cornerId: `corner-${number}`,
    objective: title,
    pullRequest: { number, title, url: `https://github.com/Beeline-Work/beeline/pull/${number}` },
  },
});
const events: ChatDisplayMessage[] = [
  pr('lead', 2742, 'Keep agent lead and body text in the same font face'),
  {
    ...base,
    id: 'issue',
    githubEvent: {
      type: 'issue',
      action: 'opened',
      actor: 'ruby',
      title: 'Production release · cancelled (run 39677669814)',
      url: 'https://github.com/Beeline-Work/beeline/issues/2744',
    },
  },
  pr('unread', 2743, "Clear a DM's unread dot when its newest reply is on screen"),
];
const opened: ChatDisplayMessage = {
  ...base,
  id: 'opened',
  daemonFact: {
    type: 'corner-open',
    cornerId: 'corner-dm',
    name: 'dm-unread-clear',
    objective: 'Clear unread',
    sourceMessageId: 'dispatch',
  },
};
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const { theme } = useUnistyles();
  const [variant, setVariant] = useState(0),
    [destination, setDestination] = useState('');
  const card = (messages: ChatDisplayMessage[]) =>
    foldPrLifecycleRuns(messages).map((message) => (
      <NotificationLifecycleCard
        key={message.id}
        message={message}
        onOpenCorner={setDestination}
        onOpenUrl={setDestination}
      />
    ));
  const callsite = variant === 3 ? callsites.parent : callsites.dm;
  const projected = callsite.messages.map((message) => ({
    ...message,
    timestamp: message.createdAt,
    isUser: message.author.kind === 'human',
  })) as ChatDisplayMessage[];
  const anchored = foldPrLifecycleRuns(anchorCornerMarkers(projected));
  const roomRecords = callsite.roomMessages.map((message) => ({
    ...message,
    timestamp: message.createdAt,
    isUser: false,
  })) as ChatDisplayMessage[];
  if (!loaded) return null;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.buzz.bgBase }}
      contentContainerStyle={{ padding: 16, paddingTop: 48 }}
    >
      <View style={{ flexDirection: 'row', gap: 16 }}>
        {(['bone', 'obsidian'] as const).map((name) => (
          <Pressable
            key={name}
            accessibilityLabel={name}
            onPress={() => UnistylesRuntime.setTheme(name)}
            style={{ minHeight: 44 }}
          >
            <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.accent }}>{name}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityLabel="Next frame"
          onPress={() => {
            setVariant((variant + 1) % 5);
            setDestination('');
          }}
          style={{ minHeight: 44 }}
        >
          <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.accent }}>Next frame</Text>
        </Pressable>
      </View>
      <Text
        accessibilityLabel={`Frame ${variant}`}
        style={{ ...theme.buzz.type.hero, color: theme.buzz.textPrimary }}
      >
        {
          [
            'A · lifecycle rows',
            'A · single and long run',
            'DM · service-projected call site',
            'Parent corner · service-projected call site',
            'Room · shared typeface',
          ][variant]
        }
      </Text>
      <View key={variant} style={{ marginTop: 24 }}>
        {variant === 0 ? (
          <>
            <Text style={{ ...theme.buzz.type.body, color: theme.buzz.textSecondary }}>
              …old cards in @System will also open the right message.
            </Text>
            <Text
              style={{
                ...theme.buzz.type.machine,
                color: theme.buzz.ledgerQuiet,
                marginVertical: 16,
              }}
            >
              › 4 steps · 12s
            </Text>
            {card(events)}
          </>
        ) : variant === 1 ? (
          <>
            {card([pr('single', 2738, 'Fix View request navigation on approval cards')])}
            <View style={{ marginTop: 24 }}>{card([opened])}</View>
            <View style={{ marginTop: 24 }}>
              {card(
                Array.from({ length: 5 }, (_, i) =>
                  pr(
                    `long-${i}`,
                    2740 - i,
                    [
                      'Replace push message scans with a transactional device outbox',
                      'Lock corner toggle',
                    ][i % 2],
                  ),
                ),
              )}
            </View>
          </>
        ) : variant === 4 ? (
          <>
            <Text
              style={{
                ...theme.buzz.type.machine,
                color: theme.buzz.ledgerQuiet,
                marginBottom: 24,
              }}
            >
              › 4 steps · 12s
            </Text>
            <Text style={{ ...theme.buzz.type.body, color: theme.buzz.textPrimary }}>
              @ruby open a corner to align the reading face.
            </Text>
            <CornerOpenedMarker
              title="shared-face"
              onOpen={() => setDestination('corner-shared-face')}
            />
            {card([pr('shared-face', 2742, 'Keep agent lead and body text in the same font face')])}
          </>
        ) : (
          anchored.map((message) => (
            <View key={message.id}>
              <Text style={{ ...theme.buzz.type.body, color: theme.buzz.textPrimary }}>
                {message.text}
              </Text>
              {message.cornerMarkers?.map((marker) => (
                <CornerOpenedMarker
                  key={marker.id}
                  title={marker.daemonFact!.name!}
                  onOpen={() => setDestination(marker.daemonFact!.cornerId)}
                />
              ))}
            </View>
          ))
        )}
        {variant >= 2 && variant < 4 ? (
          <View style={{ marginTop: 24 }}>
            <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet }}>
              Room record
            </Text>
            {card(roomRecords)}
          </View>
        ) : null}
      </View>
      <Text
        accessibilityLabel={`Destination ${destination}`}
        style={{ ...theme.buzz.type.meta, color: theme.buzz.textPrimary, marginTop: 24 }}
      >
        {destination}
      </Text>
    </ScrollView>
  );
}
registerRootComponent(Proof);
