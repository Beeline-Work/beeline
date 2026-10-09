import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
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
      <TouchableOpacity
        accessibilityLabel="Retry loading this conversation"
        accessibilityRole="button"
        hitSlop={12}
        onPress={onRetry}
        testID="room-saved-copy-retry"
      >
        <Text style={styles.action}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    paddingVertical: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.space.md,
    backgroundColor: theme.buzz.brassWash,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  message: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textPrimary },
  action: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
}));
