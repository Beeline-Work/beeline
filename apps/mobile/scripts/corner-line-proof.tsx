/** Local proof: service responses through production folding and corner rows. */
import React, { useState } from 'react';
import { ScrollView, Text, Pressable, View } from 'react-native';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { CornerOpenedMarkers } from '../sources/components/buzz/CornerOpenedMarker';
import { NotificationLifecycleCard } from '../sources/components/buzz/PrLifecycleCard';
import { anchorCornerMarkers } from '../sources/buzz/corner-markers';
import { foldPrLifecycleRuns } from '../sources/buzz/pr-lifecycle';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
import snapshots from './corner-line-proof-snapshot.json';

export default function CornerLineProof({
  initialSurface = 'room',
  initialState = 'opened',
}: {
  initialSurface?: 'room' | 'dm' | 'parent';
  initialState?: 'opened' | 'merged' | 'closed';
}) {
  const [surface, setSurface] = useState<'room' | 'dm' | 'parent'>(initialSurface);
  const [state, setState] = useState<'opened' | 'merged' | 'closed'>(initialState);
  const [destination, setDestination] = useState('');
  const { theme } = useUnistyles();
  const tokens = theme.buzz;
  const snapshot = (snapshots as Record<string, any>)[`${surface}-${state}`];
  const project = (messages: any[]): ChatDisplayMessage[] =>
    messages.map((message) => ({
      ...message,
      timestamp: message.createdAt,
      isUser: message.author?.kind === 'human',
    }));
  const marker = [...snapshot.messages]
    .reverse()
    .find(
      (message: any) =>
        message.daemonFact?.sourceMessageId &&
        (state === 'opened'
          ? message.daemonFact.type === 'corner-open'
          : message.daemonFact.outcome === (state === 'merged' ? 'landed' : 'abandoned')),
    );
  const cornerId = marker.daemonFact.cornerId;
  const rows = foldPrLifecycleRuns(
    anchorCornerMarkers(
      project(
        snapshot.messages.filter(
          (message: any) =>
            message.id === marker.id || message.id === marker.daemonFact.sourceMessageId,
        ),
      ),
    ),
  );
  const roomCards = project(
    snapshot.roomMessages.filter(
      (message: any) =>
        message.daemonFact?.cornerId === cornerId && !message.daemonFact.sourceMessageId,
    ),
  );
  const control = (label: string, onPress: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        setDestination('');
        onPress();
      }}
      style={{ minHeight: 44, justifyContent: 'center' }}
    >
      <Text style={{ ...tokens.type.meta, color: tokens.accent }}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.bgBase }}
      contentContainerStyle={{ padding: 24, paddingTop: 48 }}
    >
      <View style={{ flexDirection: 'row', gap: 24 }}>
        {(['bone', 'obsidian'] as const).map((name) =>
          control(name, () => UnistylesRuntime.setTheme(name)),
        )}
      </View>
      <View style={{ flexDirection: 'row', gap: 24 }}>
        {(['room', 'dm', 'parent'] as const).map((name) => control(name, () => setSurface(name)))}
      </View>
      <View style={{ flexDirection: 'row', gap: 24 }}>
        {(['opened', 'merged', 'closed'] as const).map((name) =>
          control(name, () => setState(name)),
        )}
      </View>
      <View testID="proof-scene" style={{ marginTop: 24, maxWidth: 720 }}>
        <Text style={{ ...tokens.type.body, color: tokens.textPrimary, marginBottom: 24 }}>
          {surface === 'room'
            ? '#Work Room'
            : surface === 'dm'
              ? '@ruby'
              : '#Work Room/parent-work'}
        </Text>
        {rows.map((message) => (
          <View key={message.id}>
            <Text style={{ ...tokens.type.meta, color: tokens.textMuted, marginBottom: 8 }}>
              Captain
            </Text>
            <Text style={{ ...tokens.type.body, color: tokens.textPrimary }}>{message.text}</Text>
            <CornerOpenedMarkers
              message={message}
              onOpenCorner={setDestination}
              onOpenUrl={setDestination}
            />
          </View>
        ))}
        {surface !== 'room' ? (
          <View style={{ marginTop: 48 }} testID="proof-room-completion">
            <Text style={{ ...tokens.type.meta, color: tokens.textMuted, marginBottom: 16 }}>
              #Work Room
            </Text>
            {foldPrLifecycleRuns(roomCards).map((message) => (
              <NotificationLifecycleCard
                key={message.id}
                message={message}
                onOpenCorner={setDestination}
                onOpenUrl={setDestination}
              />
            ))}
            {!roomCards.length ? (
              <Text style={{ ...tokens.type.meta, color: tokens.textMuted }}>
                No corner card in the Room
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      <Text
        testID="proof-destination"
        accessibilityLabel={`Destination ${destination}`}
        style={{ ...tokens.type.meta, color: tokens.textSecondary, marginTop: 48 }}
      >
        {destination}
      </Text>
    </ScrollView>
  );
}
