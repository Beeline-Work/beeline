import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/** Shared full-surface network failure. Screens supply only their retry. */
export function NetworkUnavailableState({
  onRetry,
  testID = 'network-unavailable',
}: {
  onRetry?: () => void;
  testID?: string;
}) {
  return (
    <View accessibilityRole="alert" style={styles.container} testID={testID}>
      <Text style={styles.message}>Network is not available right now.</Text>
      {onRetry ? (
        <TouchableOpacity
          accessibilityRole="button"
          onPress={onRetry}
          style={styles.retryTarget}
          testID={`${testID}-retry`}
        >
          <Text style={styles.retry}>Try again</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: {
      alignItems: 'center',
      backgroundColor: hull.bgTerminal,
      flex: 1,
      gap: hull.space.sm,
      justifyContent: 'center',
      padding: hull.space.xl,
    },
    message: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textPrimary,
      textAlign: 'center',
    },
    retryTarget: { minHeight: 44, justifyContent: 'center', paddingHorizontal: hull.space.md },
    retry: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
  };
});
