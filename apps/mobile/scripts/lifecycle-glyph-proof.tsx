/** R1 stand-in: production lifecycle rows with the reported Room run. */
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { CornerOpenedMarker } from '../sources/components/buzz/CornerOpenedMarker';
import { NotificationLifecycleCard } from '../sources/components/buzz/PrLifecycleCard';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
export default function LifecycleGlyphProof() {
  const { theme } = useUnistyles();
  const [destination, setDestination] = React.useState('');
  const buzz = theme.buzz;
  const items = [2939, 2939, 2914].map((number, index) => ({
    id: `event-${index}`, kind: 'pull-request' as const,
    state: index === 0 ? 'Opened' : 'Merged',
    title: index < 2 ? 'Preserve Android tail following' : 'Record signup screens',
    kindLine: `PR #${number}`, url: `https://github.com/Beeline-Work/beeline/pull/${number}`,
    cornerId: `corner-${number}`, actor: 'github', updatedBy: 'github',
  }));
  return <View style={{ flex: 1, backgroundColor: buzz.bgBase, padding: 24, paddingTop: 48 }}>
    <View style={{ flexDirection: 'row', gap: 24 }}>
      {(['bone', 'obsidian'] as const).map(name => <Pressable key={name} accessibilityLabel={name}
        onPress={() => UnistylesRuntime.setTheme(name)} style={{ minHeight: 44 }}>
        <Text style={{ ...buzz.type.meta, color: buzz.accent }}>{name}</Text>
      </Pressable>)}
    </View>
    <Text style={{ ...buzz.type.body, color: buzz.textPrimary, marginBottom: 24 }}>#beeline</Text>
    <Text style={{ ...buzz.type.body, color: buzz.textPrimary }}>Please fix the lifecycle glyphs.</Text>
    <CornerOpenedMarker title="lifecycle-glyphs" onOpen={() => setDestination('corner-open')} />
    <NotificationLifecycleCard message={{ id: 'r1', notificationLifecycleRun: { items, subline: '' } } as ChatDisplayMessage}
      onOpenCorner={setDestination} onOpenUrl={setDestination} />
    <Text testID="destination" style={{ ...buzz.type.meta, color: buzz.textSecondary }}>{destination}</Text>
  </View>;
}
