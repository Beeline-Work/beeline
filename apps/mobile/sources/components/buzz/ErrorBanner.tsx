import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Button, type ButtonVariant } from './Button';

/**
 * The one error banner: what failed, one short line on what it means, and its
 * own Try again button. The banner itself is never the button.
 */
export function ErrorBanner({
  description,
  onRetry,
  retryLabel = 'Try again',
  retrying = false,
  retryVariant = 'secondary',
  testID,
  title,
}: {
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  retryVariant?: ButtonVariant;
  testID?: string;
  title: string;
}) {
  return (
    <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.banner} testID={testID}>
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {onRetry ? (
        <Button
          label={retryLabel}
          loading={retrying}
          onPress={onRetry}
          style={styles.retry}
          testID={testID ? `${testID}-retry` : undefined}
          variant={retryVariant}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    banner: {
      alignItems: 'flex-start',
      padding: hull.space.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.borderStrong,
      borderRadius: hull.radius,
      backgroundColor: hull.bgRaised,
    },
    title: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
    description: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    retry: { marginTop: hull.space.sm },
  };
});
