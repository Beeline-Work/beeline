import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  tapForegroundPushNotice,
  useForegroundPushNotice,
} from '@/push/foreground-push-notice';

/**
 * Android foreground push notice: a plate at the top of the screen, over every
 * route. A tap opens the Room through the mounted navigator. Background and
 * cold-start taps still use the OS shade.
 */
export function ForegroundPushToast() {
  const notice = useForegroundPushNotice();
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  if (!notice) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.dock, { top: insets.top + theme.buzz.space.md }]}
    >
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Open ${notice.title}`}
        onPress={tapForegroundPushNotice}
        style={styles.plate}
        testID="foreground-push-notice"
      >
        <Text style={styles.title}>{notice.title}</Text>
        {notice.body ? <Text style={styles.detail}>{notice.body}</Text> : null}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  dock: {
    position: 'absolute',
    left: theme.buzz.space.md,
    right: theme.buzz.space.md,
    zIndex: 2000,
  },
  plate: {
    paddingVertical: theme.buzz.space.md,
    paddingHorizontal: theme.buzz.space.md,
    borderRadius: theme.buzz.radius,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    backgroundColor: theme.buzz.bgTerminal,
  },
  title: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  detail: { ...theme.buzz.type.meta, color: theme.buzz.textMuted },
}));
