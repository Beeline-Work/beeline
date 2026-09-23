import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** How long a copy confirmation stays up before it dismisses itself. */
export const COPIED_TOAST_MS = 2000;

/**
 * The viewer's copy feedback (copy-feedback mockup, option 2): a small raised
 * plate that rises from the bottom of the viewer and dismisses itself — a
 * check when the copy landed, a danger mark when it failed.
 */
export function useCopiedToast(testID: string): {
  showCopied(message: string): void;
  showCopyFailed(message: string): void;
  toast: React.ReactNode;
} {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState<{
    message: string;
    failed: boolean;
    at: number;
  } | null>(null);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), COPIED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  const showCopied = useCallback((message: string) => {
    setShown({ message, failed: false, at: Date.now() });
  }, []);
  const showCopyFailed = useCallback((message: string) => {
    setShown({ message, failed: true, at: Date.now() });
  }, []);
  const toast = shown ? (
    // Rides one row above the viewer's foot so it clears the image zoom bar
    // and the home indicator.
    <View
      pointerEvents="none"
      style={[
        styles.dock,
        { bottom: insets.bottom + theme.buzz.layout.row + theme.buzz.space.md },
      ]}
    >
      <Animated.View
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        entering={FadeInDown}
        exiting={FadeOutDown}
        style={styles.pill}
        testID={testID}
      >
        <View style={[styles.check, shown.failed && styles.failedMark]}>
          <Text style={styles.checkMark}>{shown.failed ? '!' : '✓'}</Text>
        </View>
        <Text style={styles.message}>{shown.message}</Text>
      </Animated.View>
    </View>
  ) : null;
  return { showCopied, showCopyFailed, toast };
}

const styles = StyleSheet.create((theme) => ({
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    paddingVertical: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.space.md,
    borderRadius: theme.buzz.radius,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    backgroundColor: theme.buzz.bgRaised,
  },
  check: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.success,
  },
  failedMark: { backgroundColor: theme.buzz.dialogDanger },
  checkMark: { ...theme.buzz.type.meta, color: theme.buzz.bgBase },
  message: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
}));
