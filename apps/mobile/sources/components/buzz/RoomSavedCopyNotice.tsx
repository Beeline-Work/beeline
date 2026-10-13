import { Button } from './Button';
import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * The band under a Room's header when its saved copy painted but the server
 * read failed (corner-open network-failure mock, frame 3): it says the
 * transcript may be stale instead of passing it off as current, and offers
 * Retry.
 */
export function RoomSavedCopyNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <View accessibilityRole="alert" style={styles.band} testID="room-saved-copy-notice">
      <Text style={styles.message}>{message}</Text>
      <Button
        label="Retry"
        variant="secondary"
        onPress={onRetry}
        accessibilityLabel="Retry loading this conversation"
        testID="room-saved-copy-retry"
        style={{ alignSelf: 'flex-end' }}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  band: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.md,
    paddingHorizontal: theme.buzz.space.md,
    backgroundColor: theme.buzz.brassWash,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  message: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
}));
