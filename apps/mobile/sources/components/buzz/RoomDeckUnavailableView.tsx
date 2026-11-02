import React from 'react';
import { Text, View, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from './Button';
import { PageHeader } from './PageHeader';

/** Recovery for a failed Room-deck read with no saved list to display. */
export function RoomDeckUnavailableView({ onReconnect, style }: {
  onReconnect: () => void;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.screen, style]} testID="room-deck-unavailable">
      <PageHeader eyebrow="Beeline" title="Rooms" prominent />
      <View accessibilityLiveRegion="polite" style={styles.recovery}>
        <View style={styles.content}>
          <Text style={styles.title}>Beeline couldn’t connect</Text>
          <Text style={styles.description}>
            Your Rooms can’t load right now. There are no saved messages on this device yet.
          </Text>
          <View style={styles.action}>
            <Button label="Reconnect" variant="secondary" onPress={onReconnect}
              testID="room-deck-reconnect" />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(({ buzz }) => ({
  screen: { flex: 1, backgroundColor: buzz.bgBase },
  recovery: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: buzz.space.xl,
    paddingBottom: buzz.space.xxl,
  },
  content: {
    alignItems: 'center',
    paddingBottom: buzz.space.xl,
    gap: buzz.space.md,
  },
  title: { ...buzz.type.hero, color: buzz.textPrimary, textAlign: 'center' },
  description: { ...buzz.type.body, color: buzz.ledgerQuiet, textAlign: 'center' },
  action: { marginTop: buzz.space.sm },
}));
