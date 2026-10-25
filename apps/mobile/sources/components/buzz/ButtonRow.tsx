import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button, type ButtonProps } from './Button';
export type ButtonRowAction = Pick<
  ButtonProps,
  | 'label'
  | 'variant'
  | 'labelTone'
  | 'accessibilityRole'
  | 'accessibilityLabel'
  | 'loading'
  | 'disabled'
  | 'onPress'
  | 'testID'
> & { busy?: boolean; description?: React.ReactNode };
/** Shared action layout for cards and inline decisions; the Button owns every target. */
export function ButtonRow({
  actions,
  style,
}: {
  actions: readonly ButtonRowAction[];
  style?: StyleProp<ViewStyle>;
}) {
  if (actions.filter((action) => action.variant === 'primary').length > 1) {
    throw new Error('A decision row permits only one primary action');
  }
  if (actions.some((action) => action.accessibilityRole === 'link')) {
    throw new Error('Links belong outside ButtonRow at the start of the footer');
  }
  return (
    <View style={[styles.row, style]}>
      {actions.map((action) => (
        <View
          key={`${action.testID ?? action.label}:${action.variant ?? 'quiet'}`}
          style={styles.slot}
        >
          <Button
            {...(action.accessibilityRole ? { accessibilityRole: action.accessibilityRole } : {})}
            label={action.label}
            labelTone={action.labelTone}
            variant={action.variant ?? 'quiet'}
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            accessibilityState={{ busy: action.busy === true }}
            loading={action.loading}
            disabled={action.disabled}
            onPress={action.onPress}
            testID={action.testID}
          />
          {action.description}
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create(({ buzz }) => ({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: buzz.space.sm,
  },
  slot: { flexShrink: 1 },
}));
