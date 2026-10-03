import * as React from 'react';
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  Text,
  type ViewStyle,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Haptics from 'expo-haptics';
import { PixelLoader } from './MonoHull';

export type ButtonVariant = 'primary' | 'secondary' | 'brass';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  /** Sentence-case verb shown on the button. */
  label: string;
  /**
   * `primary`: the filled action (one per surface).
   * `secondary`: outlined in `borderStrong`, for the alternative action.
   * `brass`: outlined in the accent, for a highlighted secondary action.
   */
  variant?: ButtonVariant;
  /** Shows the compact pixel loader, marks the button busy and disables it. */
  loading?: boolean;
  /** Stretch across the parent's cross axis. */
  fullWidth?: boolean;
  /** Outer layout only (margins, alignment, flex). Shape and type are fixed. */
  style?: StyleProp<ViewStyle>;
};

/**
 * The one button (DESIGN.md → Buttons). House radius, 44 tall, `body` label in
 * Space Grotesk Medium. Replaces MonoButton, BrassButton, OnboardingButton and
 * RoundButton.
 */
export function Button({
  label,
  variant = 'primary',
  loading = false,
  fullWidth = false,
  disabled,
  style,
  onPress,
  accessibilityState,
  ...props
}: ButtonProps) {
  const isDisabled = Boolean(disabled || loading);
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      {...props}
      accessibilityState={{ ...accessibilityState, disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={(event) => {
        if (primary) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.(event);
      }}
      style={({ pressed }) => [
        styles.frame,
        primary ? styles.primary : variant === 'brass' ? styles.brass : styles.secondary,
        pressed && !isDisabled && (primary ? styles.primaryPressed : styles.outlinedPressed),
        isDisabled && (primary ? styles.primaryDisabled : styles.outlinedDisabled),
        fullWidth && styles.fullWidth,
        style,
      ]}
    >
      {loading && <PixelLoader compact />}
      <Text
        numberOfLines={1}
        style={[
          styles.label,
          primary
            ? styles.primaryLabel
            : variant === 'brass'
              ? styles.brassLabel
              : styles.secondaryLabel,
          isDisabled && styles.disabledLabel,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const buzz = theme.buzz;
  return {
    frame: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: buzz.space.md,
      borderRadius: buzz.radius,
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: buzz.space.sm,
    },
    primary: { backgroundColor: buzz.buttonPrimaryFill, borderColor: buzz.buttonPrimaryFill },
    secondary: { backgroundColor: 'transparent', borderColor: buzz.borderStrong },
    brass: { backgroundColor: 'transparent', borderColor: buzz.accent },
    primaryPressed: { opacity: 0.85 },
    outlinedPressed: { backgroundColor: buzz.bgPressed },
    primaryDisabled: { backgroundColor: buzz.bgRaised, borderColor: buzz.bgRaised },
    outlinedDisabled: { borderColor: buzz.border },
    fullWidth: { alignSelf: 'stretch' },
    label: { ...buzz.type.body, fontFamily: buzz.proseMedium },
    primaryLabel: { color: buzz.buttonPrimaryText },
    secondaryLabel: { color: buzz.buttonSecondaryText },
    brassLabel: { color: buzz.accent },
    disabledLabel: { color: buzz.textDisabled },
  };
});
