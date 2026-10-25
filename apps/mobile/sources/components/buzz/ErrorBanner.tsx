import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Button, type ButtonVariant } from './Button';

/**
 * The one error banner: what failed, one short line on what it means, and its
 * own Retry button. The banner itself is never the button.
 */
export function ErrorBanner({
  inline = false,
  description,
  onRetry,
  retryLabel = 'Retry',
  retrying = false,
  retryTestID,
  retryVariant = 'secondary',
  testID,
  secondaryAction,
  title,
  titleTestID,
}: {
  inline?: boolean;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
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
      style={inline ? styles.inline : styles.banner}
      testID={testID}
    >
      <Text style={inline ? styles.inlineText : styles.title} testID={titleTestID}>
        {inline && description ? `${title} ${description}` : title}
      </Text>
      {!inline && description ? (
        <Text style={inline ? styles.inlineText : styles.description}>{description}</Text>
      ) : null}
      {onRetry || secondaryAction ? (
        <View
          style={inline ? styles.inlineActions : secondaryAction ? styles.actions : styles.retry}
        >
          {onRetry ? (
            <Button
              size={inline ? 'inline' : 'default'}
              label={retryLabel}
              loading={retrying}
              onPress={onRetry}
              testID={retryTestID ?? (testID ? `${testID}-retry` : undefined)}
              variant={retryVariant}
            />
          ) : null}
          {secondaryAction ? (
            <Button
              size={inline ? 'inline' : 'default'}
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
    banner: {
      marginHorizontal: hull.space.md,
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
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: hull.space.sm,
      marginTop: hull.space.sm,
    },
  };
});
