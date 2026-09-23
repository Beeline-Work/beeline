import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** How long a copy confirmation stays up before it dismisses itself. */
export const COPIED_TOAST_MS = 2000;

/**
 * The viewer's copy confirmation (copy-feedback mockup, option 2): a small
 * raised plate with a check that rises from the bottom of the viewer and
 * dismisses itself. Failures stay on the alert path; this only ever confirms
 * a copy that landed.
 */
export function useCopiedToast(testID: string): {
  showCopied(message: string): void;
  toast: React.ReactNode;
} {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState<{ message: string; at: number } | null>(null);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), COPIED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  const showCopied = useCallback((message: string) => {
    setShown({ message, at: Date.now() });
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
        <View style={styles.check}>
          <Text style={styles.checkMark}>✓</Text>
        </View>
        <Text style={styles.message}>{shown.message}</Text>
      </Animated.View>
    </View>
  ) : null;
  return { showCopied, toast };
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
  checkMark: { ...theme.buzz.type.meta, color: theme.buzz.bgBase },
  message: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
}));
