import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Button } from './Button';

/**
 * The one empty state: what is missing, one short line on how to fill it,
 * and at most one secondary action.
 */
export function EmptyState({
  action,
  description,
  testID,
  title,
}: {
  action?: { accessibilityLabel?: string; label: string; onPress: () => void; testID?: string };
  description?: string;
  testID?: string;
  title: string;
}) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.empty} testID={testID}>
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {action ? (
        <Button
          accessibilityLabel={action.accessibilityLabel ?? action.label}
          label={action.label}
          onPress={action.onPress}
          style={styles.action}
          testID={action.testID}
          variant="secondary"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    empty: {
      alignItems: 'center',
      paddingHorizontal: hull.space.lg,
      paddingVertical: hull.space.xl,
      gap: hull.space.xs,
    },
    title: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary, textAlign: 'center' },
    description: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      textAlign: 'center',
    },
    action: { marginTop: hull.space.md },
  };
});
