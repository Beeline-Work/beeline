import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button, type ButtonDestination, type ButtonVariant } from './Button';

/**
 * Shared contextual failure sentence and its existing actions. Whole-page
 * and list failures use IndexRow; no framed error-banner variant remains.
 */
export function ErrorBanner({
  icon,
  description,
  onRetry,
  retryLabel = 'Retry',
  retryDestination,
  retrying = false,
  retryTestID,
  retryVariant = 'secondary',
  testID,
  secondaryAction,
  title,
  titleTestID,
}: {
  inline?: true;
  icon?: React.ReactNode;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Where the retry goes when it leaves this screen (`Button.destination`). */
  retryDestination?: ButtonDestination;
  retrying?: boolean;
  retryTestID?: string;
  retryVariant?: ButtonVariant;
  testID?: string;
  secondaryAction?: {
    label: string;
    onPress(): void;
    disabled?: boolean;
    testID?: string;
    icon?: React.ReactNode;
    iconOnly?: boolean;
    accessibilityLabel?: string;
  };
  title: string;
  titleTestID?: string;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={styles.inline}
      testID={testID}
    >
      {icon}
      <Text style={styles.inlineText} testID={titleTestID}>
        {description ? `${title} ${description}` : title}
      </Text>
      {onRetry || secondaryAction ? (
        <View
          style={styles.inlineActions}
        >
          {onRetry ? (
            <Button
              size="inline"
              label={retryLabel}
              destination={retryDestination}
              loading={retrying}
              onPress={onRetry}
              testID={retryTestID ?? (testID ? `${testID}-retry` : undefined)}
              variant={retryVariant}
            />
          ) : null}
          {secondaryAction ? (
            <Button
              size="inline"
              label={secondaryAction.label}
              icon={secondaryAction.icon}
              iconOnly={secondaryAction.iconOnly}
              accessibilityLabel={secondaryAction.accessibilityLabel}
              onPress={secondaryAction.onPress}
              disabled={secondaryAction.disabled}
              testID={secondaryAction.testID ?? (testID ? `${testID}-secondary` : undefined)}
              variant="quiet"
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    inline: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: hull.space.sm,
    },
    inlineText: { ...hull.type.meta, color: hull.dialogDanger, flexShrink: 1 },
    inlineActions: {
      maxWidth: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: hull.space.md,
    },
  };
});
