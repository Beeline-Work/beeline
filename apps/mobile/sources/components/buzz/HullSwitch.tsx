import React from 'react';
import { Platform, Switch } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

export type HullSwitchProps = {
  accessibilityLabel?: string;
  disabled?: boolean;
  /** False inside a disabled row, which already carries the disabled opacity. */
  dimWhenDisabled?: boolean;
  onValueChange: (value: boolean) => void;
  testID?: string;
  value: boolean;
};

/**
 * The one switch: brass when on, the disabled-text colour when off. The thumb
 * stays light in both themes so it reads against either track.
 */
export function HullSwitch({
  accessibilityLabel,
  dimWhenDisabled = true,
  disabled,
  onValueChange,
  testID,
  value,
}: HullSwitchProps) {
  const { theme } = useUnistyles();
  const hull = theme.buzz;
  const thumb = hull.dark ? hull.textPrimary : hull.textInverted;
  return (
    <Switch
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      // The off track must stand apart from the surface, or the thumb floats
      // alone and the state cannot be read.
      ios_backgroundColor={hull.textDisabled}
      onValueChange={onValueChange}
      // Custom track colours stop the platform from dimming a disabled switch.
      style={disabled && dimWhenDisabled ? styles.disabled : undefined}
      testID={testID}
      thumbColor={thumb}
      // react-native-web paints the on thumb from its own prop.
      {...(Platform.OS === 'web' ? { activeThumbColor: thumb } : {})}
      trackColor={{ false: hull.textDisabled, true: hull.accent }}
      value={value}
    />
  );
}

const styles = { disabled: { opacity: 0.42 } } as const;
